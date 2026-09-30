# 0021. Desktop: PWA only until a named trigger, then Tauri 2

- Status: Accepted
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: docs/STACK.md v2, corrections log row C21

## Context

Stack v1 said "Tauri later" without a trigger. A second build target should not be added without a reason.

## Decision

Desktop is served by the **PWA only** until one of these triggers is met:
- offline model storage exceeds the browser quota, or
- native file-system watch is needed.

Then wrap the same web build in **Tauri 2**.

## Consequences

Positive:
- Avoids a second build target without a reason.
- One web build serves desktop.

Negative:
- Desktop users are limited by browser storage quotas and PWA capabilities until a trigger is met. (architect-reviewed 2026-09-30)
- Adding Tauri later requires signing, auto-update and distribution work that is not planned in the current roadmap. (architect-reviewed 2026-09-30)

## Alternatives rejected

- **Build a Tauri desktop app now** (v1, vague): a second build target without a reason.
