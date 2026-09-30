# Progress

| Date | Task | PR | Notes |
|------|------|----|-------|
| 2026-09-30 | P0-01 | #4 | ADRs 0001–0023, index, pending decisions. Negative consequences not in STACK.md are marked "architect-reviewed 2026-09-30". |
| 2026-09-30 | P0-02 | #5 | Repo initialised: Node 24 (engine-strict), pnpm 10.34.6, workspace, .npmrc with save-exact, empty dirs, proprietary LICENSE. ROADMAP P0-02 steps 3–4 amended to match. |
| 2026-09-30 | P0-03 | #6 | Claude Code workspace audited; gaps closed. 39 deny rules, each proven by a permission_denial test with a no-rule control. Added: destructive-SQL/remote-DB denies, drizzle-kit push/drop, push-to-main and trailing --force gaps, `.env.production*` read/edit at any depth. `/next-task` and CLAUDE.md Workflow step 2 now stop for approval on every task; `/new-module` and `/migration` are tests-first. Known limits: patterns match literal command text, so mixed case (`DrOp`), SQL in a file (`psql -f reset.sql`), `bash -c`/`env` wrappers, run-time variables, already-exported `PGHOST`/`DATABASE_URL`, and scripts (`node -e`, `pnpm tsx`) are not blocked; `Bash(cat .env.production)` is not blocked by Read rules; `psql *drop*` also blocks harmless psql commands containing "drop". Case-insensitive PreToolUse hook deferred — revisit at P13 when production credentials first exist. |
