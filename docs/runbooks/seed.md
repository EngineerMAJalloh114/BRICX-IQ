# Seeding the local dev database (`pnpm db:seed`)

P6-05b, ADR 0076. Local stack only: the seed refuses production and any database host but `localhost`, `127.0.0.1` or `::1`.

## First time

```bash
cp .env.example .env      # pnpm dev:up also creates it when missing
pnpm dev:up
pnpm db:migrate
pnpm db:seed
```

`pnpm db:seed` runs `tsx` with the repository's `.env`. Without `.env` it stops at once with `node: .env: not found`: copy `.env.example` (it carries `NODE_ENV=development` and the dev `DATABASE_URL`).

A good run prints one line, the same every time:

```
seed: organizations 2, users 24, region_configs 4, roles 24, role_permissions 590, memberships 24, projects 2, sites 4, project_memberships 18, project_membership_sites 4; no drift
```

(The counts follow `@bricx/permissions`: 12 roles today, and the default bundles' keys.)

## Running it again

Run it as often as you like: rows already there are compared and left alone. The seed never updates or deletes.

If a seeded row was changed (in the app, or by hand), the run stops with `seed drift: <table> <id>` and exit code 1, naming no value. Either put the row back, or start over:

```bash
pnpm dev:reset
pnpm dev:up
pnpm db:migrate
pnpm db:seed
```

## Refusals

| Message (keys and codes only) | Why |
|---|---|
| `NODE_ENV: missing` | `NODE_ENV` unset or empty; set `development` |
| `NODE_ENV: seed_refused_in_production` | the seed never runs in production |
| `DATABASE_URL: seed_non_local_host` | a host (or a `?host=`) that is not `localhost`, `127.0.0.1` or `::1`, a unix socket, or no host |
| `DATABASE_URL: seed_role_not_bricx_app` | a user (or a `?user=`) other than `bricx_app`; the seed connects as the app does |
| `seed refused: the database user is not bricx_app` | the server says `current_user` is not `bricx_app` |

## What it writes

Two organisations, `seed-sahel-builders` (cell `af-south-1`) and `seed-atlas-constructions` (cell `eu-west-1`), each with the twelve roles, one user per role (subject `seed-<a|b>-<role>`), one active project and two sites. The users have no Keycloak account yet (P7-05), and the organisations are not registered in the global directory. No audit events are written. The Nairobi project's language `ar` is the right-to-left fixture.

## Changing the dataset

Edit `packages/db/seed/dataset.ts` (or change a role bundle in `@bricx/permissions`), then regenerate the committed ids and commit them:

```bash
pnpm exec tsx packages/db/seed/generate-ids.ts
pnpm exec prettier --write packages/db/seed/ids.ts
```

The dataset test (`packages/db/test/seed-dataset.test.ts`) fails until `ids.ts` matches.
