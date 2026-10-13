# 0042. otel-lgtm cold start: 300 s healthcheck window and SQLite WAL for Grafana

- Status: Accepted
- Date: 2026-10-13
- Deciders: Mohamed Abass Jalloh
- Source: ROADMAP.md P2-01c; ADR 0034 (dev stack); P2-01c requirements 1–7 and plan approval 1–5 (2026-10-13)

## Context

On the owner's machine (WSL2, 7.6 GiB RAM) a cold `pnpm dev:up` failed with "container bricx-dev-otel-lgtm-1 is unhealthy". The container log said "Grafana is up and running. Startup time: 166 seconds"; the other LGTM components took 3–5 s, and the container reported healthy later. Earlier cold starts on that machine were healthy at 123 s, 136 s and 146 s; whole `pnpm dev:up` runs took 2m18s to 2m52s.

The healthcheck was `interval: 10s`, `retries: 5`, `start_period: 120s`. Docker counts no failures inside `start_period`; after it, 5 consecutive failures 10 s apart mark the container unhealthy. So the deadline was about 120 + 50 = 170 s, and a 166 s Grafana start (plus the image's own ready file, written after every component answers) sat right on it.

Root cause, measured in the agent environment (4 vCPU Xeon 2.1 GHz, 15.7 GiB RAM, virtio disk with 3,483 fdatasync/s; image `grafana/otel-lgtm:0.34.0`, Grafana 13.2.2):

- On a fresh volume Grafana runs 813 SQLite schema migrations on its own database (`/data/grafana/data/grafana.db`). Grafana's default `[database] wal = false` uses SQLite's rollback journal, so every migration commit waits on several fsyncs: cold start time follows the disk's write latency.
- Normal disk: Grafana ready in 6 s alone; 15 s, 6 s and 6 s inside three full `pnpm dev:reset && pnpm dev:up` runs (54, 43, 42 s).
- Write I/O limited to 50 IOPS (`--device-write-iops`): Grafana ready in **344 s**, the first 719 migrations alone took 4m04s, the other components still 1–5 s (the owner's signature).
- Same limit with `GF_DATABASE_WAL=true`: **74 s** (4.6× faster).
- Ruled out: plugin downloads (`GF_PLUGINS_PREINSTALL` and the Drilldown apps) run in Grafana's background installer and do not delay `/api/health`, even with grafana.com made to hang; provisioning takes about 1 s.
- **Not measured:** the owner's disk fsync rate on WSL2, and how much the other seven services' cold start adds to it. The owner's failing run has no Grafana detail (`ENABLE_LOGS_GRAFANA` is off).

## Decision

- **otel-lgtm `start_period` is 300 s** (was 120 s): unhealthy only after about 350 s, 2.1× the worst observed 166 s. It delays failure counting only; a healthy start is reported healthy at the first passing check (`start_interval: 3s`). `pnpm dev:up` still waits at most 600 s.
- **`GF_DATABASE_WAL: "true"` on otel-lgtm** (owner's ruling, 2026-10-13; documented Grafana setting `[database] wal`, "for sqlite3 only"; dev stack only; no image or version change) (for architect review):
  - What it changes: the SQLite journal mode of Grafana's own database only (users, dashboards, alerting state), not Loki, Tempo or Prometheus data. SQLite writes commits to `grafana.db-wal` and keeps an index in `grafana.db-shm`, both next to `grafana.db` in the `otel-lgtm-data` volume, and folds them back into `grafana.db` at checkpoints.
  - Measured here only: 344 s → 74 s on a 50-IOPS disk; three cold `pnpm dev:reset && pnpm dev:up` runs with it passed (43, 39, 43 s; Grafana 8, 6, 6 s; all services healthy; `-wal` and `-shm` present) and a warm restart passed (35 s). **It was not measured on the owner's disk**; the PR's "Verify locally (owner)" section prints Grafana's startup time for three cold starts there.
  - Grafana logs "Database locked, sleeping then retrying" (SQLITE_BUSY, info level, retried) a few times at start with and without WAL; no errors.
  - Revert: remove the `GF_DATABASE_WAL` line from `infrastructure/docker/compose.yml`, then `pnpm dev:reset` (deletes local data) so Grafana starts from a fresh volume.
- **The compose guard holds a 300 s floor for otel-lgtm** (`startPeriodFloors` in `scripts/guards.mjs`, otel-lgtm only by the owner's ruling). A missing `start_period`, an interpolated value (`${...}`), a bare number or anything else that is not a literal compose duration fails closed; `300s`, `5m` and `"6m30s"` pass. `check:workspace` also fails if `compose.yml` has no `otel-lgtm` service, so renaming it cannot silently drop the floor. Ten fixtures prove the rule on every run.

## Consequences

- A slow cold start no longer fails `pnpm dev:up`; a broken Grafana is reported unhealthy about 3 minutes later than before (at about 350 s instead of 170 s).
- The README's cold-start budget states the measured range (2m18s to 2m52s on the owner's machine before this change, Grafana 166 s). ROADMAP P2-01's "< 3 min" held on that machine, with little margin; WAL is expected to widen it, unmeasured there until the owner runs the probe.
- An existing `otel-lgtm-data` volume switches to WAL on its next start; no reset is needed to adopt it, only to revert it.
- Raising another service's `start_period` needs no guard change; lowering otel-lgtm's below 300 s fails `check:workspace` until the floor itself is changed.

## Alternatives rejected

- **Window only (no WAL):** the owner ruled it only hides the slowness.
- **240 s or 360 s:** 240 s leaves 1.75× margin; 360 s (ClamAV's value) delays reporting a broken Grafana by another minute for no measured need.
- **Floors for `s3` and `clamav` too:** not asked for; otel-lgtm only (owner's ruling).
- **Fewer Grafana migrations or no Grafana:** no supported setting skips migrations; dropping Grafana changes ADR 0034's D1 ruling.
