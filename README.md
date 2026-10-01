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

## Where to read next

- [CLAUDE.md](CLAUDE.md): project rules and working conventions
- [docs/STACK.md](docs/STACK.md): the technology stack
- [docs/ROADMAP.md](docs/ROADMAP.md): the implementation roadmap, task by task
