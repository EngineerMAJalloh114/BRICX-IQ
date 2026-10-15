# 0050. Hybrid execution model from P4

- Status: Accepted
- Date: 2026-10-15
- Deciders: Mohamed Abass Jalloh
- Source: maintenance task "execution-model transition (tiny-step -> hybrid)" scope items 1–3 and the architect-supplied CLAUDE.md Workflow text (block 1, items 1, 2, 6–9), 2026-10-15; plan approval with changes, 2026-10-15; owner review of PR #42 (changes 1–8), 2026-10-15

Changes how ROADMAP tasks are executed. No phase or task content changes.

## Context

From P0 to P3 every task followed the **tiny-step model** (CLAUDE.md Workflow items 1, 2 and 6 before this ADR; ROADMAP §0):

- one task per session, one thread, one branch `<task-id>-<slug>`, one PR;
- plan mode first, and the plan stopped for owner approval on every task; 🔒 tasks additionally required architect review of the PR before merge;
- after the PR opened, the session stopped; the next task started in a new thread only after the owner named it.

P3 closed with the exit check in PR #41 (main `741b825`): P3-01 to P3-06 ticked, `@bricx/ids`, `money`, `validation`, `permissions` and `domain` at or above 95% line coverage, zero `any` in `packages/*/src` by TypeScript AST count, `pnpm verify` green.

Reason for the change: P4–P24 hold most of the roadmap's tasks, and under the tiny-step model each one costs a separate thread, a separate plan approval and a full stop, even when a task is small and independent of the open PR. A phase-level plan approved once, with the per-task stops kept only where risk is concentrated (🔒 tasks and phase gates), keeps owner control at the points that matter while removing the per-task wait. (Wording of the reason inferred from the task statement; for architect review.)

## Decision

**Hybrid execution model**, effective from P4 onward, after the verified P3 exit. CLAUDE.md Workflow items 1, 2 and 6 are replaced and items 7–9 added with the architect's text as corrected in the owner's review; items 3–5 are unchanged. The CLAUDE.md "Read first" ROADMAP bullet and "Session start" task bullet, and `.claude/commands/next-task.md`, follow the same rule:

- **One phase = one thread** (resumable across sessions). Inside it: one branch `<task-id>-<slug>` and one PR per task, run in ROADMAP order. No parallel threads; a task is never split across sub-agents.
- **Session start.** Find the phase: the first phase whose exit the owner has not approved, or the one the human names. Inside an approved phase plan, work tasks in ROADMAP order, skipping tasks marked "Moved to". Work on nothing outside the approved plan. ("Read first": work one phase at a time, tasks in order.)
- **Phase kickoff plan.** In plan mode, ONE phase plan (task order, dependencies, decisions needed from the owner, risks, how each Done-when is verified), then stop for owner approval. A material change to the approved plan (a new or reordered task, a new dependency, a new decision) needs owner re-approval before work continues.
- **Pipelining.** After a non-🔒 PR opens, the thread may start the next task from main only if it is independent: it does not need the open PR's code and does not touch the same files, migration sequence or generated artefacts; a dependent task waits for the merge. When an earlier PR merges, each open branch is rebased and its ROADMAP.md and PROGRESS.md conflicts resolved before work continues.
- **PR title.** `<type>(<scope>): <summary> (<task-id>)`, checked by commitlint in the pr-title CI job; the squash merge puts it on main.
- **Batching.** Small non-🔒 tasks in the same package may share one PR; the PR body lists every task ID with its own Done-when checklist. The title carries the first task ID.
- **Tracking.** ROADMAP.md stays authoritative; subtasks remain the tracking units (tick + PROGRESS row per task).

Safeguards (architect-reviewed, unchanged by the hybrid model):

- **🔒 tasks** keep their own task plan and stop for approval before any code is written. After a 🔒 PR opens, stop: start no further task until the architect has reviewed and the owner has merged.
- **Phase exit.** The thread posts an evidence report (each task's Done-when and the phase exit criteria, with command output); the next phase does not start until the owner approves it.
- Tests before implementation, `pnpm verify` green, one PR per task (or per approved batch), never merge: unchanged.

ROADMAP.md gets an "Execution model" section at the top describing the above, and a one-line pointer at the top of §0 ("How to use this roadmap") marking §0 as the tiny-step model used for P0–P3.

## Consequences

Positive:
- One approval per phase instead of one per task; independent non-🔒 tasks proceed while earlier PRs wait for review.
- Risk-concentrated work (🔒: security, money, sync, migrations) keeps the same two stops as before.

Negative:
- More PRs can be open at once, so reviews may queue and later PRs may need updating after earlier merges. (for architect review)
- Re-approval of material plan changes adds an owner stop inside a phase whenever the plan changes. (for architect review)
- Rebasing an open branch that was already pushed needs a force-push to update its PR, and CLAUDE.md "Never" forbids force-push; `git merge` is denied in `.claude/settings.json`. How an open branch takes an earlier merge is therefore not yet settled. (for architect review)

## Alternatives rejected

- **Keep the tiny-step model for P4–P24**: per-task approval and thread overhead for every task, including small independent ones.
- **Fully autonomous phases** (no per-task stops at all): removes the 🔒 plan approval and architect review that the money, security, sync and migration tasks need.
