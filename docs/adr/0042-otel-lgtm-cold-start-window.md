# 0042. Cold-start healthcheck windows for otel-lgtm, keycloak and powersync; SQLite WAL for Grafana

- Status: Accepted
- Date: 2026-10-13
- Deciders: Mohamed Abass Jalloh
- Source: ROADMAP.md P2-01c; ADR 0034 (dev stack); P2-01c requirements 1–7, plan approval 1–5 and amendment 1–5 (2026-10-13)

## Context

On the owner's machine (WSL2, 7.6 GiB RAM) cold `pnpm dev:up` runs failed on three different services, each of which reported healthy later:

- "container bricx-dev-otel-lgtm-1 is unhealthy": the container log said "Grafana is up and running. Startup time: 166 seconds"; the other LGTM components took 3–5 s. Earlier otel-lgtm cold starts were healthy at 123 s, 136 s and 146 s.
- With this ADR's first change (otel-lgtm only), 3 cold starts: run 1 failed with "container bricx-dev-powersync-1 is unhealthy" after a 146.7 s wait (2m56s in total); run 2 passed in 2m50s (powersync healthy at 64.9 s, keycloak 143.8 s, otel-lgtm 131.3 s, Grafana 118 s); run 3 passed in 1m40s (powersync 26.2 s, keycloak 78.1 s, otel-lgtm 62.8 s, Grafana 54 s).
- Whole `pnpm dev:up` runs on that machine took **1m40s to 2m56s**.

Docker counts no healthcheck failures inside `start_period`; after it, `retries` consecutive failures `interval` apart mark the container unhealthy, and `pnpm dev:up` (`up --wait`) fails at once. The old deadlines, from container start, were about 120 + 5 × 10 = 170 s for otel-lgtm, 120 + 5 × 10 = 170 s for keycloak and 60 + 3 × 10 = 90 s for powersync.

Measured in the agent environment (4 vCPU Xeon 2.1 GHz, 15.7 GiB RAM, virtio disk with 2,300–3,500 fdatasync/s; the images pinned in ADR 0034). Times are from the container's start unless stated: a service's healthy time is the first once-a-second poll of its status that read healthy, less the container's `State.StartedAt` (±1 s).

**otel-lgtm (Grafana 13.2.2).** On a fresh volume Grafana runs 813 SQLite schema migrations on its own database (`/data/grafana/data/grafana.db`). Grafana's default `[database] wal = false` uses SQLite's rollback journal, so every migration commit waits on several fsyncs: cold start time follows the disk's write latency.

- Normal disk: Grafana ready in 6 s alone; 6–15 s inside full cold starts.
- Write I/O limited to 50 IOPS: Grafana ready in **344 s** (the first 719 migrations took 4m04s), the other components 1–5 s (the owner's signature). Same limit with `GF_DATABASE_WAL=true`: **74 s** (4.6× faster).
- The first cold start after the Docker daemon restarted (see powersync below), with WAL on: Grafana 134 s, otel-lgtm healthy 139 s after start. WAL removes the write cost, not slow reads of the image's files, so the window is still needed.
- Ruled out: plugin downloads run in Grafana's background installer and do not delay `/api/health`, even with grafana.com made to hang; provisioning takes about 1 s.

**powersync (1.26.1).** It waits on its own Node process booting, not on replication or storage. Until the HTTP API listens, the healthcheck fails with "diagnostics request failed (TypeError)" (connection refused). The storage migrations run just before the API starts listening (1.2–2.1 s); after it listens, replication slot creation, the initial snapshot and stream activation take 0.3–1.5 s, and the first diagnostics call after that is healthy. From the start of the migrations to the active stream: 1.7–2.9 s (8 runs).

- Normal disk: first log line about 6 s after start, modules loaded at about 11 s, healthy at 12–18 s (3 runs).
- 50 write IOPS on every service: healthy at 10 s (writes are not its bottleneck).
- Reads limited to 20 MB/s or 10 MB/s (and 200 read IOPS) on every service: first log line 28–30 s after start, healthy at 36–38 s; one healthcheck itself exceeded its 5 s timeout (it starts `node` too).
- The first cold start after the Docker daemon restarted (image files not cached by the host): first log line **72 s** after start, healthy at **92 s**; it was marked unhealthy at about 82 s under the old window and recovered 10 s later: the owner's run-1 failure. Timeline from its `docker logs` (container started 11:48:08.5): "Booting PowerSync Service" 11:49:20.5 (+72 s), "Loading dynamic modules" 11:49:20.6, "Successfully loaded dynamic modules" 11:49:35.1 (+87 s), storage migrations 11:49:35.5 to 11:49:37.1, "Running on port 8080" 11:49:37.7 (+89 s), "Created replication slot" 11:49:38.0, "Activated new replication stream" 11:49:38.4 (+90 s), then healthy at the next check.
- The stream activates 0.3–0.7 s after the API listens (1.5 s with writes limited to 50 IOPS). A check still running when the API starts, or started before the stream is active, can report "unhealthy: no active sync config", and PowerSync may log a PSYNC_S4001 warning ("Could not determine replication lag for slot …"): the sync config is not yet active and the new slot has no lag to report. The health message appeared in 2 of the 7 runs whose health log was captured (one check started 0.2 s before the API listened, the other between the API listening and the stream activating), the warning in 1 of 8 runs; each lasted under 1 s, and the next check (2 s later) was healthy; they are part of those 1.7–2.9 s, not a separate wait.
- Not the cause: the replication slot (created 0.2–0.4 s after the API listens in seven runs, 1.2 s with writes limited to 50 IOPS); storage init (storage is Postgres, `powersync_storage`, not MongoDB; its 9 migrations take 1–2 s); a Keycloak JWKS fetch (`powersync.yaml` configures no client auth or JWKS URI, the log shows no fetch, and PowerSync does not depend on Keycloak).

**keycloak (26.7.5, `start-dev`).** Dev mode rebuilds Quarkus ("augmentation") on every start, then imports the placeholder realm.

- Normal disk: augmentation 23.1–24.8 s, "started in" 23.6–24.3 s (realm import about 2 s), healthy at 59–61 s (3 runs).
- 50 write IOPS: augmentation 48.2 s, "started in" 25.7 s, healthy at 81 s. Reads at 20 or 10 MB/s: augmentation 29.0–35.6 s, "started in" 24.8–26.0 s, healthy at 75–81 s. Across all 7 runs: augmentation 23.1–48.2 s, "started in" 23.6–26.0 s.
- The first cold start after the daemon restart: first log line **89 s** after start, augmentation 40 s, startup 24.5 s, healthy at **182 s**; it was marked unhealthy at about 161 s under the old window and recovered.

**Not measured:** the owner's disk read and fsync rates on WSL2; whether the owner's slow first runs are cold image reads (as here) or CPU contention between the eight services; Grafana, Keycloak and PowerSync logs from the owner's failing runs. The first-after-restart case could not be reproduced on demand here: dropping the guest page cache before a cold start gave normal times (whole stack healthy 62–72 s), so the slow reads come from below the guest (the host's cache), which the slow-read limit only approximates.

## Decision

Why, in short: Grafana's first start is bound by fsync (813 SQLite migrations); PowerSync's and Keycloak's are bound by how fast their processes boot, which on the owner's WSL2 machine varies run to run (1m40s to 2m56s in total; the first start after a restart is the slowest). The windows absorb that variance; WAL removes Grafana's write cost.


- **`start_period` per service**, set from the measurements above with margin (the deadline adds `retries` × `interval`; `retries` and `start_interval` are unchanged, since the root cause is a slow first boot, not a flapping check). It delays failure counting only: a healthy start is reported at the first passing check (`start_interval` 2–3 s), and `pnpm dev:up` still waits at most 600 s.

  | Service | Old → new `start_period` | Unhealthy after (from start) | Worst measured | Margin |
  | --- | --- | --- | --- | --- |
  | otel-lgtm | 120 s → **300 s** | about 350 s | 166 s (owner, Grafana) | 2.1× |
  | keycloak | 120 s → **300 s** | about 350 s | 182 s (here, first start after the daemon restart) | 1.9× |
  | powersync | 60 s → **180 s** | about 210 s | 92 s (here, same run) | 2.3× |

  Keycloak 300 s is the owner's ruling (2026-10-13 13:42Z); it leaves 1.9× the 182 s measured here and 2.4× the owner's worst Keycloak figure (144 s, measured from the start of `pnpm dev:up`, so an upper bound on the time from container start).

- **`GF_DATABASE_WAL: "true"` on otel-lgtm** (owner's ruling, 2026-10-13; documented Grafana setting `[database] wal`, "for sqlite3 only"; dev stack only; no image or version change) (for architect review):
  - What it changes: the SQLite journal mode of Grafana's own database only (users, dashboards, alerting state), not Loki, Tempo or Prometheus data. SQLite writes commits to `grafana.db-wal` and keeps an index in `grafana.db-shm`, both next to `grafana.db` in the `otel-lgtm-data` volume, and folds them back into `grafana.db` at checkpoints.
  - Measured here only: 344 s → 74 s on a 50-IOPS disk; every cold start since (6 with `pnpm dev:up`, all exit 0) had `-wal` and `-shm` present and Grafana ready in 6–12 s; the first start after a daemon restart still took 134 s (slow image reads, not writes). On the owner's disk Grafana took 118 s and 54 s with it (amendment runs 2 and 3), against 123–166 s without it, from the owner's own figures; no controlled comparison was made there.
  - Grafana logs "Database locked, sleeping then retrying" (SQLITE_BUSY, info level, retried) a few times at start with and without WAL; no errors.
  - Revert: remove the `GF_DATABASE_WAL` line from `infrastructure/docker/compose.yml`, then `pnpm dev:reset` (deletes local data) so Grafana starts from a fresh volume.
- **The compose guard holds the floors** (`startPeriodFloors` in `scripts/guards.mjs`: otel-lgtm 300 s, keycloak 300 s, powersync 180 s; the owner's amendment replaces the earlier "otel-lgtm only" ruling). A missing `start_period`, an interpolated value (`${...}`), a bare number or anything else that is not a literal compose duration fails closed; literal durations at or above the floor pass, in seconds, minutes or both (`300s`, `5m`, `"6m30s"`). `check:workspace` also fails if `compose.yml` lacks any of the three services, so a rename cannot silently drop a floor. 28 fixtures (9 per service plus one service without a floor) prove the rule on every run.

## Consequences

- A slow cold start no longer fails `pnpm dev:up`. A broken Grafana is reported about 3 minutes later than before (at about 350 s instead of 170 s), a broken Keycloak about 3 minutes later (about 350 s instead of 170 s), a broken PowerSync about 2 minutes later (about 210 s instead of 90 s).
- The README's cold-start budget states the owner's measured range (1m40s to 2m56s). ROADMAP P2-01's "< 3 min" held only narrowly on that machine (2m56s, in a run that failed); this ADR stops the failures, not the slowness, except for Grafana's database writes.
- An existing `otel-lgtm-data` volume switches to WAL on its next start; no reset is needed to adopt it, only to revert it.
- Raising a `start_period` needs no guard change; lowering one below its floor fails `check:workspace` until the floor itself is changed.

## Alternatives rejected

- **Window only for otel-lgtm (no WAL):** the owner ruled it only hides the slowness.
- **A shorter or longer otel-lgtm window:** one minute less leaves 1.75× margin; 360 s (ClamAV's value) delays reporting a broken Grafana by another minute for no measured need.
- **More `retries` instead of a longer `start_period`:** retries also apply after a service was healthy, so they would slow detection of a crash in normal use; `start_period` affects only startup.
- **Floors for `s3` and `clamav` too:** not asked for; neither failed on the owner's machine.
- **Fewer Grafana migrations, no Grafana, or Keycloak's optimized (pre-built) mode:** no supported setting skips Grafana's migrations; dropping Grafana changes ADR 0034's D1 ruling; a pre-built Keycloak needs a custom image, which the compose guard forbids (`build:` is refused; ADR 0034 pins upstream images).
