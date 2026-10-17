Make a new API module from `apps/api/src/modules/_template` (P4-09, ADR 0059). `$ARGUMENTS` is `<module> <Entity> <subject>`, e.g. `milestones Milestone project.milestone`.

1. Commit or stash first: the script refuses a dirty tree.
2. Run `pnpm new-module $ARGUMENTS`. Never copy or edit the template by hand. If the script refuses, report its messages to the user and stop.
3. It prints "review the generated migration (rule 12)" with the file. Read every statement in it and tell the user it needs their review (CLAUDE.md rule 12). Never say it is reviewed.
4. Run `pnpm verify` and `pnpm test:integration`. Then write the module's real tests before changing its behaviour (tests first), replacing the template's stand-in behaviour.
5. Sync is not wired: a copy is never published to PowerSync. Wiring it (publication `ADD TABLE` + `GRANT SELECT … TO powersync_repl` in one migration, a stream scope, the leak test) is P8-02's.
