# 0036. S3 dev bucket: created by an `s3-init` one-shot, not by SeaweedFS on startup

- Status: Accepted
- Date: 2026-10-02
- Deciders: Mohamed Abass Jalloh
- Source: ROADMAP.md P2-01b; ADR 0034 (dev stack); P2-01b requirements 1–9, option (a), and approval conditions 1–8 (2026-10-02)

## Context

ADR 0034 let SeaweedFS create the `S3_BUCKET` bucket on startup. On the owner's machine (fresh volume, cold start) the bucket was never created: `docker compose logs s3` showed `lookup bucket bricx-dev: ... dial unix /tmp/seaweedfs-filer-grpc-18888.sock: no such file or directory`, `/buckets` listed only `.system`, the healthcheck returned 404 for 110 s and `dev:up` failed with "s3 is unhealthy".

The cause is in SeaweedFS 4.48's `weed mini` (`weed/command/mini.go`): it waits at most 30 × 200 ms (about 6 s) for each component, logs "Health check for Filer failed" and carries on; then `ensureMiniBuckets` tries each bucket once, logs a warning on failure and never retries. The filer also sleeps 7 s after any failed first call to the master, which alone exceeds the 6 s budget.

Reproduced on demand in the agent environment by limiting the s3 container's write I/O (compose `blkio_config`, 2 write IOPS): the same log line, `/buckets` with only `.system`, and `up --wait` exiting 1 after about 103 s. Throttling CPU (0.05, 0.02 and 0.01 CPU) or starving it did not reproduce it.

## Decision

- **A one-shot `s3-init` service creates the bucket** (`infrastructure/docker/s3/create-bucket.sh`), using the same pinned `chrislusf/seaweedfs:4.48` image and `weed shell` `s3.bucket.create`. Success means the bucket directory exists in the filer: it checks before creating and again after, and never parses the shell's output. Bounded: at most 60 attempts, 2 s apart, and at most 180 s in total; every `weed shell` call has a 10 s timeout (it waits for the master without a limit) and every existence check 3 s. If the bucket still does not exist, it exits 1 with `s3-init FAILED: bucket <name> does not exist after <n> attempts ...`. Running it again on an existing bucket succeeds at the first check. Before anything else it validates the name against S3 naming (`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`, in POSIX `case` patterns) and exits 1 without calling `weed shell` if it does not match: the name is echoed into the shell's stdin, where a newline would start a second command (architect review 2026-10-06).
- **The `s3` service no longer gets `S3_BUCKET`**, so `weed mini` makes no racing attempt of its own. It reads the same `.env` key as `BRICX_S3_BUCKET` for its healthcheck, which still requires `/buckets/<bucket>/` (existing `.env` files need no new key). The `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` pair still creates the S3 admin identity; the integration test proves it with a signed PUT and GET.
- **`pnpm dev:up` runs each one-shot with `docker compose run --rm`** after the Postgres step and before the final `up --wait`, and stops with its exit code if it fails. `s3-init` is in the compose profile `init`, so a plain `docker compose up` does not start it: Compose v5.3.1's `up --wait` exits 1 on every warm rerun ("container s3-init exited (0)") when nothing depends on an exited one-shot. A plain `docker compose up` therefore leaves `s3` unhealthy by design; `pnpm dev:up` is the only supported way to start the stack (README). When `api` and `worker` join the compose stack (P4), they depend on `s3-init` with `service_completed_successfully` (ROADMAP P4-01, P4-06).
- **The s3 healthcheck's `start_period` is 240 s** (was 60 s), longer than `s3-init`'s 180 s deadline. Under the I/O fault `s3-init` created the bucket after 125 s, but Docker had already marked `s3` unhealthy at about 110 s and `up --wait` failed at once. The healthcheck test is unchanged and the start period ends at the first success, so a healthy `s3` still means the bucket exists.
- **The compose guard exempts only one-shots from the healthcheck rule.** A service may lack a healthcheck only if its name ends in `-init`, its profiles are exactly `init`, it has `restart: "no"` and a `depends_on`, publishes no ports, and has no healthcheck (one would be hollow: the service it initialises proves the result). Profiles are allowed on nothing else. 11 fixtures prove the rules on every `check:workspace`.
- **Permanent regression test** `tooling/db-bootstrap/test/s3-bucket.int.test.ts` (Testcontainers; image, command, environment, entrypoint, bind mount and healthcheck read from `docker compose config` on the real `compose.yml`): the fault case pauses `s3` so the filer is unreachable when `s3-init` starts, requires at least one failed attempt, then unpauses and requires the bucket, a healthy healthcheck and a signed PUT/GET (a wrong secret gets 403); the healthcheck fails while the bucket is missing; a second run is idempotent; a filer that never answers gives exit 1 and the message within bounds. Removing the retry fails the fault case.
- **Cold-start proofs run at least 3 times** in a row (README, PROGRESS): one cold start can win a race the next one loses.

## Consequences

Positive:
- The bucket exists whenever `s3` is healthy, however slowly the filer starts, within a 180 s bound; past that, `dev:up` fails with a message naming the bucket.
- The race is covered by a permanent test that fails without the retry.

Negative:
- `pnpm dev:up` is now required: a plain `docker compose up` leaves `s3` unhealthy. Anyone used to plain Compose meets an unhealthy service instead of a working stack. (architect-reviewed 2026-10-06)
- The s3 healthcheck's start period is 240 s, so a broken `s3` is reported unhealthy up to 3 minutes later than before when started outside `pnpm dev:up` (inside it, `s3-init` fails first, at 180 s). (architect-reviewed 2026-10-06)
- The compose guard now has an exemption (one-shots without a healthcheck); the rules keep it narrow, but it is one more rule to keep right. (architect-reviewed 2026-10-06)
- The permanent test injects the fault by pausing the container, not by the I/O limit that reproduced the owner's log: the I/O limit depends on the host's block device and cgroup setup, which CI runners do not guarantee. The pause proves `s3-init` waits for a filer that is not answering, not that `weed mini` loses its own race. (architect-reviewed 2026-10-06)
- `create-bucket.sh` depends on `weed shell` and busybox `wget`/`timeout` inside the pinned image; an image bump must re-run the integration test (it reads the image from `compose.yml`, so CI does). (architect-reviewed 2026-10-06)
- The integration test reads the stack through `docker compose config`, so the CI runner needs the Compose plugin (GitHub's Ubuntu runners have it). (architect-reviewed 2026-10-06)

## Alternatives rejected

- **(b) A retrying wrapper inside the `s3` service:** worked in a prototype, but makes a shell script PID 1 of the `s3` container, and its fault cannot be injected portably (pausing the container also pauses the retry loop).
- **Keeping `S3_BUCKET` on `s3` alongside `s3-init`:** two creators racing; the image's attempt fails silently on slow starts and adds nothing.
- **Parsing `weed shell` output for "already exists":** fragile (owner condition 1); the existence check is the source of truth.
- **No Compose profile, nothing depending on `s3-init`:** every warm `up --wait` exits 1.
