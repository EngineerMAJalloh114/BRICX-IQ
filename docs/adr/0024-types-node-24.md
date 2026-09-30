# 0024. Add `@types/node` 24.x as a root devDependency

- Status: Accepted
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: ROADMAP.md P1-01; ADR 0023 (dependency policy); ADR 0015 (Node.js 24)

## Context

P1-01 adds `@bricx/tsconfig/node.json` for apps/api and apps/worker. It needs Node.js type definitions (`types: ["node"]`). `@types/node` is not listed in DEPENDENCIES.md, and ADR 0023 requires an ADR for every new dependency.

## Decision

- Add **`@types/node`** as an exact-pinned root devDependency (DEPENDENCIES.md §1), first pinned at **24.19.0**.
- Its **major version tracks the Node.js runtime** (24, per ADR 0015), not the npm `latest` tag (26.x at the time of writing). Upgrades stay within 24.x until the runtime ADR changes.
- Only `node.json` loads it. `base.json`, `web.json` and `react-native.json` set `types: []`, so Node globals do not leak into browser or React Native code.

## Consequences

Positive:
- API and worker code type-checks against the Node 24 APIs it actually runs on.
- Node globals such as `process` fail type-checking outside Node code.

Negative:
- Renovate must be held to 24.x for this package, or it will propose majors that do not match the runtime. (pending architect review)
- It brings the transitive `undici-types` package. (pending architect review)

## Alternatives rejected

- **`@types/node@latest` (26.x)**: describes APIs Node 24 does not have.
- **Per-workspace `@types/node`**: several copies to keep in sync; one root pin is enough.
