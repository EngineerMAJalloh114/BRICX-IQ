Create migration `$ARGUMENTS`: write the integration test first; never edit an applied migration. Then update Drizzle schema, run `pnpm db:generate`, then open the SQL and review it:
expand/contract safe, FORCE RLS on new tenant tables, grants for bricx_app (no UPDATE/DELETE on append-only tables),
publication changes for synced tables. Apply locally with `pnpm db:migrate` and run `pnpm test:integration`.
