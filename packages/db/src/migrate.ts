// The migrator (P4-02, ADR 0052). drizzle-orm's own migrator always runs
// CREATE SCHEMA IF NOT EXISTS, which bricx_owner may not (no CREATE on the
// database), so this one applies drizzle-kit's output itself:
//
// - only as bricx_owner (checked first), into schemas the bootstrap made;
// - under a session advisory lock, so concurrent runs serialise and the
//   later one finds nothing to do;
// - one transaction per migration: its statements and its history row
//   commit together or not at all;
// - history in bricx_migrations.applied (idx, tag, sha256, applied_at);
// - refusing, before anything runs, an applied migration that was
//   removed, moved or edited, or a new one below the highest applied idx.
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { SecretUrl } from "./database.js";
import { type Migration, readMigrations } from "./journal.js";
import { MigrationError } from "./migration-error.js";

export { MigrationError, type MigrationErrorCode } from "./migration-error.js";
export type { SecretUrl } from "./database.js";

/** This package's migrations folder (drizzle-kit's `out`). */
export const MIGRATIONS_DIR = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

/** The role every migration runs as (ADR 0035). */
export const MIGRATION_ROLE = "bricx_owner";

/** pg_advisory_lock key: hashtext('bricx_migrations'), fixed. */
const LOCK_KEY = "hashtext('bricx_migrations')";

export interface MigrateResult {
  /** Tags applied by this run, in order. */
  readonly applied: readonly string[];
  /** How many were already applied before this run. */
  readonly alreadyApplied: number;
}

export interface MigrateOptions {
  /** Bound on connecting, in milliseconds (default 10 s). */
  readonly connectTimeoutMs?: number;
}

interface AppliedRow {
  idx: number;
  tag: string;
  sha256: string;
}

const HISTORY_DDL = `CREATE TABLE IF NOT EXISTS bricx_migrations.applied (
  idx integer PRIMARY KEY,
  tag text NOT NULL UNIQUE,
  sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

/** The SQLSTATE and server message of a driver error, if it has them. */
function serverError(error: unknown): { sqlState?: string; message?: string } {
  if (typeof error !== "object" || error === null) return {};
  const code = "code" in error ? error.code : undefined;
  const message = "message" in error ? error.message : undefined;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)
    ? { sqlState: code, ...(typeof message === "string" ? { message } : {}) }
    : {};
}

/** Which pending migrations to run, or the refusal. */
export function plan(
  migrations: readonly Migration[],
  applied: readonly AppliedRow[],
): readonly Migration[] {
  const byTag = new Map(migrations.map((m) => [m.tag, m]));
  for (const row of applied) {
    const migration = byTag.get(row.tag);
    if (migration === undefined) {
      throw new MigrationError("applied_migration_removed", { tag: row.tag });
    }
    if (migration.idx !== row.idx) {
      throw new MigrationError("applied_migration_reordered", { tag: row.tag });
    }
  }
  for (const row of applied) {
    if (byTag.get(row.tag)?.sha256 !== row.sha256) {
      throw new MigrationError("applied_migration_changed", { tag: row.tag });
    }
  }
  const done = new Set(applied.map((row) => row.tag));
  const highest = Math.max(-1, ...applied.map((row) => row.idx));
  const pending = migrations.filter((m) => !done.has(m.tag));
  const below = pending.find((m) => m.idx < highest);
  if (below !== undefined) {
    throw new MigrationError("gap_fill", { tag: below.tag });
  }
  return pending;
}

async function connect(url: SecretUrl, timeoutMs: number): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString: url.reveal(),
    connectionTimeoutMillis: timeoutMs,
  });
  // A dropped connection emits here; the pending query rejects with it.
  client.on("error", () => undefined);
  try {
    await client.connect();
  } catch {
    await client.end().catch(() => undefined);
    throw new MigrationError("database_unavailable");
  }
  return client;
}

/** Runs `sql`; a driver failure becomes database_unavailable, no detail. */
async function query<R extends pg.QueryResultRow>(
  client: pg.Client,
  sql: string,
): Promise<R[]> {
  try {
    return (await client.query<R>(sql)).rows;
  } catch {
    throw new MigrationError("database_unavailable");
  }
}

async function applyOne(
  client: pg.Client,
  migration: Migration,
): Promise<void> {
  await query(client, "BEGIN");
  let statement = 0;
  try {
    for (const sql of migration.statements) {
      statement += 1;
      await client.query(sql);
    }
    statement = 0;
    await client.query(
      "INSERT INTO bricx_migrations.applied (idx, tag, sha256) VALUES ($1, $2, $3)",
      [migration.idx, migration.tag, migration.sha256],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    const { sqlState, message } = serverError(error);
    throw new MigrationError("migration_failed", {
      tag: migration.tag,
      ...(statement > 0 ? { statement } : {}),
      ...(sqlState === undefined ? {} : { sqlState }),
      ...(message === undefined ? {} : { serverMessage: message }),
    });
  }
}

/**
 * Applies every pending migration in `folder` (default: this package's)
 * as bricx_owner. Throws MigrationError on any refusal or failure; the
 * URL is revealed only to the driver.
 */
export async function migrate(
  url: SecretUrl,
  folder: string = MIGRATIONS_DIR,
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  const migrations = await readMigrations(folder);
  const client = await connect(url, options.connectTimeoutMs ?? 10_000);
  try {
    const [who] = await query<{ user: string; schema: string | null }>(
      client,
      `SELECT current_user AS user,
              (SELECT nspowner::regrole::text FROM pg_namespace
                WHERE nspname = 'bricx_migrations') AS schema`,
    );
    if (who?.user !== MIGRATION_ROLE) throw new MigrationError("wrong_role");
    if (who.schema !== MIGRATION_ROLE) {
      throw new MigrationError("missing_schema");
    }
    await query(client, `SELECT pg_advisory_lock(${LOCK_KEY})`);
    try {
      await query(client, HISTORY_DDL);
      const applied = await query<AppliedRow>(
        client,
        "SELECT idx, tag, sha256 FROM bricx_migrations.applied ORDER BY idx",
      );
      const pending = plan(migrations, applied);
      const done: string[] = [];
      for (const migration of pending) {
        await applyOne(client, migration);
        done.push(migration.tag);
      }
      return { applied: done, alreadyApplied: applied.length };
    } finally {
      await client
        .query(`SELECT pg_advisory_unlock(${LOCK_KEY})`)
        .catch(() => undefined);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}
