# BRICX IQ

BRICX IQ is a global construction management platform. It brings the whole construction project lifecycle into one connected environment: planning, field operations, workforce, procurement, finance, documents, quality, safety and reporting.

It is offline-first, multi-currency, multilingual and cross-platform (iOS, Android and web), with strong security and a complete audit trail.

## Prerequisites

- Node.js 24 (see `.nvmrc`)
- pnpm 10 (pinned in `package.json` via `packageManager`; enable with `corepack enable`)
- Docker (for the local service stack)

## Getting started

```bash
corepack enable
pnpm install
pnpm tools:gitleaks
```

`pnpm install` sets up the git hooks. `pnpm tools:gitleaks` installs the pinned gitleaks binary (Linux x64 / WSL; ADR 0030). Commits are blocked until it is installed.

## Local development stack

```bash
pnpm dev:up      # start Postgres, Valkey, S3 (SeaweedFS), Keycloak, PowerSync, Mailpit, ClamAV, Grafana LGTM
pnpm dev:down    # stop it; data volumes are kept
pnpm dev:reset   # delete it and its data (refuses unless it is the local bricx-dev stack)
```

`pnpm dev:up` creates `.env` from `.env.example` (fake local-only credentials) on first run and waits until every service is healthy. Every port listens on `127.0.0.1` only: Postgres 5432, Valkey 6379, S3 8333, Keycloak 8080, PowerSync 8089, Mailpit 1025 (SMTP) and 8025 (UI), ClamAV 3310, Grafana 3000, OTLP 4317/4318. Image versions and why: [ADR 0034](docs/adr/0034-local-dev-stack-versions.md).

Memory: the stack settles at about 2.7 GB. Give Docker at least 4 GB; 8 GB is comfortable with an IDE and the app running. On Windows with WSL 2, set this in `%UserProfile%\.wslconfig`, then run `wsl --shutdown`:

```ini
[wsl2]
memory=8GB
swap=4GB
```

## Where to read next

- [CLAUDE.md](CLAUDE.md): project rules and working conventions
- [docs/STACK.md](docs/STACK.md): the technology stack
- [docs/ROADMAP.md](docs/ROADMAP.md): the implementation roadmap, task by task
