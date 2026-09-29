# BRICX-IQ

BRICX IQ is a global construction management platform that connects project planning, field operations, workforce, inventory, procurement, finance, documents, communication, quality, safety, and reporting through secure, offline-capable, multilingual, multi-currency, cross-platform tools with complete accountability.

## Repository layout

| Path              | What it is                                                                       |
| ----------------- | -------------------------------------------------------------------------------- |
| `apps/mobile`     | Expo (React Native) app for iOS, Android and web, local-first with PowerSync     |
| `apps/api`        | Node API (Fastify) on PostgreSQL; validates and audits every change from devices |
| `packages/shared` | Types and rules shared by both: money and currencies, synced tables, validation  |
| `infra`           | Local configuration for PostgreSQL and the PowerSync sync service                |

## How offline sync works

1. The app reads and writes a SQLite database on the device (IndexedDB in browsers), so it works with no connection.
2. PowerSync queues local changes and, when online, uploads them to the API (`POST /sync/upload`).
3. The API validates each change, applies the whole batch in one transaction and records it in the append-only `audit_log` with who made it and the before and after values.
4. PowerSync replicates committed rows from PostgreSQL back down to every device.

Money is stored as integer minor units (cents, fils, …) next to its ISO 4217 currency code, never as floating point.

## Getting started

Requires Node 22+, pnpm 10 (`corepack enable`) and Docker.

```bash
pnpm install
docker compose up -d          # PostgreSQL + PowerSync service
pnpm db:migrate               # create tables
pnpm dev:api                  # API on http://localhost:4000
pnpm dev:mobile               # Expo; press w for web
```

On iOS and Android the app uses native SQLite, so it runs in a development build (`npx expo run:ios` / `run:android`) rather than Expo Go. Set `EXPO_PUBLIC_API_URL` when the API is not on `localhost`.

Sign-in is a development placeholder (`POST /auth/dev-token`, disabled in production) until real authentication is added.

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm test          # API tests need PostgreSQL (DATABASE_URL, defaults to the compose database)
pnpm format:check
```

CI runs all of these plus a web build on every pull request.
