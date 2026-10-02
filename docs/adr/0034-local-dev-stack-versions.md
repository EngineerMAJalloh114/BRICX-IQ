# 0034. Local development stack: pinned images, SeaweedFS for S3, loopback-only ports

- Status: Accepted
- Date: 2026-10-02
- Deciders: Mohamed Abass Jalloh
- Source: ROADMAP.md P2-01; DEPENDENCIES.md §8 (Local, Docker Compose); ADR 0012 (uploads), ADR 0015 (PostgreSQL 18), ADR 0023 (dependency policy); P2-01 rulings A1, B1, C2, D1, E, F2, G1, H, I1, J2 and additions 1–9 (2026-10-02)

## Context

P2-01 adds the local Docker Compose stack: Postgres 18 + PostGIS, Valkey, Keycloak, an S3-compatible store, PowerSync, Mailpit, ClamAV and dev observability. Every image is a dependency (ADR 0023), so each needs an exact version, a reason, and a row in DEPENDENCIES.md.

What was found on 2026-10-01 and 2026-10-02:

- **MinIO is unobtainable.** `minio/minio` and `minio/mc` no longer exist on Docker Hub. The upstream README says "THIS REPOSITORY IS NO LONGER MAINTAINED" and "The MinIO community edition is now distributed as source code only"; the replacement it names, AIStor Free, is under a proprietary licence. quay.io is blocked from the agent environment, so quay.io/minio could not be checked.
- **quay.io is blocked from the agent environment.** Keycloak's primary registry is quay.io; the Keycloak project also publishes `keycloak/keycloak` on Docker Hub.
- **PostgreSQL 18 with PostGIS exists.** `postgis/postgis:18-3.6` ran PostgreSQL 18.6 with PostGIS 3.6.4, `wal_level=logical`, a working native `uuidv7()`, and `postgis`, `pg_trgm`, `btree_gist`, `pgcrypto` and `pg_stat_statements` available. The PostgreSQL 17 fallback of ADR 0015 is not needed. Upstream publishes no patch-level tag; the digest pins 18.6.
- **PowerSync without P2-02.** With no `powersync` publication, PowerSync 1.26.1 starts and its liveness probe answers 200, but replication logs `PSYNC_S1141 Publication 'powersync' does not exist` on every retry.

## Decision

- **Images (DEPENDENCIES.md §8 lists each `repo:tag`; `infrastructure/docker/compose.yml` pins each as `repo:tag@sha256:<index digest>`; every one has a linux/amd64 manifest):**

  | Image | Index digest | Notes |
  |---|---|---|
  | `postgis/postgis:18-3.6` | `sha256:60f6ad1d21ea86a67d47780b9a0d1e1d200500f62b19293fa834d0dea80b8677` | PostgreSQL 18.6, PostGIS 3.6.4 |
  | `valkey/valkey:8.1.10` | `sha256:640c5e62cea04b6d6f2084232651d0cc70362d31f4f805e7be94dbed6855e8f2` | stays on 8.x, the DEPENDENCIES baseline (E) |
  | `chrislusf/seaweedfs:4.48` | `sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d` | replaces MinIO (A1) |
  | `keycloak/keycloak:26.7.5` | `sha256:37dbaf6f0722c9ec246335f36e1ef8b2e6cb960f7c27e0d8c615121a3d475a85` | Docker Hub copy (B1); not the same-day 26.8.0 (C2) |
  | `journeyapps/powersync-service:1.26.1` | `sha256:413a0c813e96935ebe7203b5759f8a594a7b7cd8aa42134713e63af637e0f079` | Open Edition |
  | `axllent/mailpit:v1.31.3` | `sha256:ed9b00c609e77e99c79b93f1178255ebc271868920f2c69a8d166bd5634ed10d` | |
  | `clamav/clamav:1.4.6` | `sha256:57deb108fc4c72778aa83eafbca7bb7153e28c3f57c005afd38d31f16da86f23` | 1.4 LTS (F2) |
  | `grafana/otel-lgtm:0.34.0` | `sha256:b966ea107831d526d9eb8fe4d2d86c9e5731392fad9dce8296bcf2072031f07c` | includes the OTel Collector; no separate collector service (D1) |

- **SeaweedFS replaces MinIO for local S3 (A1).** Apache-2.0, weekly releases, S3 multipart and presigned URLs. It runs as `weed mini` with S3 credentials from `.env`, telemetry, WebDAV, the admin UI and the Iceberg/Lance ports off. It creates the `S3_BUCKET` bucket on startup when it is missing, and its healthcheck fails until that bucket exists, so a healthy `s3` service means the bucket exists. Production is AWS S3 (STACK.md). This partly supersedes ADR 0012's "MinIO locally"; ADR 0012's body is unchanged. **Condition (addition 1): P8-06 must prove multipart + presigned URLs + CORS against SeaweedFS; if it fails, swap the dev emulator (production is AWS S3).**
- **No s3-init one-shot.** `docker compose up --wait` (Compose v5.3.1) exits 1 when a one-shot service exits, even with code 0, unless a running service depends on it with `service_completed_successfully`, and nothing needs the bucket yet. SeaweedFS's startup bucket creation needs no one-shot, so every service keeps a healthcheck and the guard has no exemption.
- **Postgres:** `wal_level=logical`, `pg_stat_statements` preloaded. The bootstrap superuser comes from `POSTGRES_SUPERUSER_*` and is never used by application code (addition 3); `.env.example` has no application `DATABASE_URL`. Extensions, roles and the `powersync` publication are created in P2-02. One init file creates the `powersync_storage` database for PowerSync's bucket storage (H).
- **PowerSync until P2-02 (G1, H):** replicates as the bootstrap superuser, with no publication, so replication does NOT stream yet; its healthcheck is the liveness probe only. ROADMAP P2-02 now requires removing the superuser replication (use `powersync_repl`) and a healthcheck that proves replication is streaming (addition 2). No `client_auth` until P5, so no JWT key. Telemetry sharing off.
- **Keycloak until P5-01:** `start-dev --import-realm` with `infrastructure/docker/keycloak/bricx-placeholder-realm.json` (realm `bricx-placeholder`, display name "PLACEHOLDER: replaced in P5-01", no clients, no users); data in Keycloak's dev file store on a named volume.
- **ClamAV:** the image's own healthcheck (`clamdcheck.sh`) and 6-minute start period, unchanged. The image ships a signature database, so clamd starts before the first freshclam update.
- **Security:** every published port is bound to `127.0.0.1`. Credentials are obviously fake (`dev-only-…`) values in `.env.example`; `.env` is gitignored and `pnpm dev:up` creates it from the example. The pinned gitleaks 8.30.1 finds nothing in them, so no allowlist is needed; a base64 key (such as a PowerSync HS256 `k`) would trip `generic-api-key`.
- **Scripts:** `pnpm dev:up` (up, wait until every service is healthy), `pnpm dev:down` (keeps volumes), `pnpm dev:reset` (deletes the stack and its volumes, but refuses unless `DOCKER_HOST` is unset or a unix socket, the current Docker context's endpoint is a unix socket, the project is `bricx-dev`, and every volume it would delete is a `bricx-dev_` volume labelled `com.bricx.stack=local-dev`).
- **Permanent guard (I1):** `check:workspace` runs `composeProblems` on `infrastructure/docker/compose.yml` and fails on an image not pinned as `repo:tag@sha256:<64 hex>`, a `latest` tag, an image `repo:tag` missing from DEPENDENCIES.md, a port not bound to `127.0.0.1` (short syntax only), a service without a healthcheck or with a disabled one, `build:`, `network_mode: host`, `include`/`extends`, and YAML the line-based guard cannot read (anchors, aliases, merge keys, flow style, tabs, oddly indented lists). 22 compose fixtures and 7 dev:reset fixtures in `scripts/guard-fixtures/` prove each rule on every run.
- **Verify command (J2):** `pnpm dev:up && docker compose ps --format json | jq -se 'length > 0 and all(.[]; .Health == "healthy")'`. `docker compose ps --format json` prints one object per line, so the earlier `jq -e 'all(.Health=="healthy")'` errored on every run. The root `.env` sets `COMPOSE_FILE` and `COMPOSE_PROJECT_NAME`, so plain `docker compose` works from the repo root.
- **Resources:** measured in the agent environment (4 vCPU, 15.7 GiB), the stack's memory settles at about 2.7 GiB; Keycloak (~0.8 GiB) and ClamAV (~0.95 GiB) are the largest. Minimum: give Docker 4 GB; recommended 8 GB with an IDE and the app running. WSL users set this in `%UserProfile%\.wslconfig` (see README "Local development stack").

## Consequences

Positive:
- One command starts every local service, and `--wait` fails unless all are healthy.
- Images cannot drift: a re-pushed tag cannot change what runs, and an unlisted, unpinned or `latest` image fails `check:workspace`.
- Nothing listens beyond the developer's machine.

Negative:
- SeaweedFS is not MinIO or AWS S3; S3 behaviour the app relies on (multipart, presigned URLs, CORS) is unproven until P8-06, and a failure there means swapping the dev emulator. (for architect review)
- Until P2-02, PowerSync reports healthy while replication does not stream; healthy means "service live", not "syncing". (for architect review)
- Keycloak is pulled from Docker Hub, not quay.io; the agent could not compare the two digests, so the owner compares them before merge. (for architect review)
- Digests were resolved through Docker Hub only (registry and Hub API, which agreed). Docker Hub rate-limits anonymous pulls (100 per hour per IP when measured), which a shared network can hit. (for architect review)
- Dependabot (ADR 0033) does not watch the compose images; image bumps are manual until the `docker-compose` ecosystem is decided at P13. Tags like `18-3.6` are rebuilt upstream, so a bump means re-resolving the digest. (for architect review)
- The compose guard reads YAML line by line in our plain style; it fails closed on constructs it cannot read, which can reject valid Compose YAML. (for architect review)
- ClamAV's signature updates were not observed: freshclam in the agent container failed on TLS (the container does not trust the agent's proxy certificate), so the measured cold start used the signatures baked into the image (daily 28136). A freshclam reload can briefly double clamd's memory. (for architect review)

## Alternatives rejected

- **Garage (A2):** AGPL-3.0, and needs layout and key bootstrap on first start.
- **RustFS (A3):** its 1.0 release was two weeks old.
- **`pgsty/minio` (A4):** a third party's rebuild of unmaintained code.
- **AIStor Free (A5):** proprietary licence key.
- **Keycloak 26.8.0 (C1):** released the same day; not adopted (C2).
- **A separate `otel/opentelemetry-collector-contrib` service (D2):** `grafana/otel-lgtm` already runs a collector.
- **PowerSync healthcheck that requires replication now (G2):** cannot pass before P2-02; P2-02 adds it.
- **An s3-init one-shot:** see Decision; `up --wait` fails on it.
