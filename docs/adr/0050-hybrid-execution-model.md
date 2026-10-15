# 0050. Hybrid execution model from P4

- Status: Accepted
- Date: 2026-10-15
- Deciders: Mohamed Abass Jalloh
- Source: maintenance task "execution-model transition (tiny-step -> hybrid)" scope items 1–3 and the architect-supplied CLAUDE.md Workflow text (block 1, items 1, 2, 6–9), 2026-10-15; plan approval with changes, 2026-10-15

Changes how ROADMAP tasks are executed. No phase or task content changes.

## Context

From P0 to P3 every task followed the **tiny-step model** (CLAUDE.md Workflow items 1, 2 and 6 before this ADR; ROADMAP §0):

- one task per session, one thread, one branch `<task-id>-<slug>`, one PR;
- plan mode first, and the plan stopped for owner approval on every task; 🔒 tasks additionally required architect review of the PR before merge;
- after the PR opened, the session stopped; the next task started in a new thread only after the owner named it.

P3 closed with the exit check in PR #41 (main `741b825`): P3-01 to P3-06 ticked, `@bricx/ids`, `money`, `validation`, `permissions` and `domain` at or above 95% line coverage, zero `any` in `packages/*/src` by TypeScript AST count, `pnpm verify` green.

Reason for the change: P4–P24 hold most of the roadmap's tasks, and under the tiny-step model each one costs a separate thread, a separate plan approval and a full stop, even when a task is small and independent of the open PR. A phase-level plan approved once, with the per-task stops kept only where risk is concentrated (🔒 tasks and phase gates), keeps owner control at the points that matter while removing the per-task wait. (Wording of the reason inferred from the task statement; for architect review.)

## Decision

**Hybrid execution model**, effective from P4 onward, after the verified P3 exit. CLAUDE.md Workflow items 1, 2 and 6 are replaced and items 7–9 added with the architect's exact text; items 3–5 are unchanged:

- **One phase = one thread** (resumable across sessions). Inside it: one branch `<task-id>-<slug>` and one PR per task, run in ROADMAP order. No parallel threads; a task is never split across sub-agents.
- **Phase kickoff plan.** In plan mode, ONE phase plan (task order, dependencies, decisions needed from the owner, risks, how each Done-when is verified), then stop for owner approval.
- **Pipelining.** After a non-🔒 PR opens, the thread may start the next task from main if it does not depend on the open PR; a dependent task waits for the merge.
- **Batching.** Small non-🔒 tasks in the same package may share one PR; the PR body lists every task ID with its own Done-when checklist.
- **Tracking.** ROADMAP.md stays authoritative; subtasks remain the tracking units (tick + PROGRESS row per task).

Safeguards (architect-reviewed, unchanged by the hybrid model):

- **🔒 tasks** keep their own task plan and stop for approval before any code is written, and after a 🔒 PR opens the thread stops: no dependent work until the architect has reviewed and the owner has merged.
- **Phase exit.** The thread posts an evidence report (each task's Done-when and the phase exit criteria, with command output); the next phase does not start until the owner approves it.
- Tests before implementation, `pnpm verify` green, one PR per task (or per approved batch), never merge: unchanged.

ROADMAP.md gets an "Execution model" section at the top describing the above, and a one-line pointer at the top of §0 ("How to use this roadmap") marking §0 as the tiny-step model used for P0–P3.

## Consequences

Positive:
- One approval per phase instead of one per task; independent non-🔒 tasks proceed while earlier PRs wait for review.
- Risk-concentrated work (🔒: security, money, sync, migrations) keeps the same two stops as before.

Negative:
- More PRs can be open at once, so reviews may queue and later PRs may need updating after earlier merges. (for architect review)
- A phase plan approved up front can go stale as tasks land; a change of plan inside a phase is not a defined gate. (for architect review)
- CLAUDE.md "Session start" ("Find the task: first unchecked ID in ROADMAP.md, or the ID the human names. Work on nothing else.") and `.claude/commands/next-task.md` ("stop for approval on every task … Do not start any other task") still describe the tiny-step model; this ADR does not change them (the task allowed only the block 1 Workflow text in CLAUDE.md). (for architect review)
- Workflow item 9 refers to a roadmap PDF generated from ROADMAP.md and checked for drift. No generator or PDF exists yet: it was removed from this change by the owner, and whether to build it is a separate owner decision. (for architect review)

## Alternatives rejected

- **Keep the tiny-step model for P4–P24**: per-task approval and thread overhead for every task, including small independent ones.
- **Fully autonomous phases** (no per-task stops at all): removes the 🔒 plan approval and architect review that the money, security, sync and migration tasks need.
