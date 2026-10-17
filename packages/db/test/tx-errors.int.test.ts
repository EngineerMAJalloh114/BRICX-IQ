// P4-07 (ADR 0057, amends 0053 and 0051): what withTx() does when things
// go wrong after it started, against compose.yml's Postgres.
// - A COMMIT that fails after fn resolved (a DEFERRABLE INITIALLY DEFERRED
//   constraint) is TransactionCommitError with the SQLSTATE only (owner
//   condition 3); an error inside fn is still rethrown unchanged.
// - A backend terminated while its client is checked out (inside fn) does
//   not crash the process: the next statement rejects, the pool discards
//   the client, and the next withTx() works (the Also line from PR #52).
import {
  type BootstrappedPostgres,
  appDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type Database,
  TransactionCommitError,
  openDatabase,
  sqlstateOf,
} from "../src/database.js";
import { migrate } from "../src/migrate.js";
import { writeMigrations } from "./fixture-migrations.js";

const ORG_A = "0199e1a0-0000-7000-8000-00000000000a";
const USER = "0199e1a0-0000-7000-8000-000000000001";
const ctxA = { orgId: ORG_A, userId: USER, projectIds: [] };
const ORG_SETTING = "NULLIF(current_setting('app.org_id', true), '')::uuid";

let pg18: BootstrappedPostgres;
let db: Database;

const urlFor = (role: string, key: string) => ({
  reveal: () =>
    `postgres://${role}:${exampleValue(key)}@${pg18.container.getHost()}:${String(pg18.container.getMappedPort(5432))}/${appDatabase}`,
});

async function asAdmin(
  text: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const admin = await pg18.admin();
  try {
    return (await admin.query(text, params)).rows as Record<string, unknown>[];
  } finally {
    await admin.end();
  }
}

beforeAll(async () => {
  pg18 = await startPostgres();
  const dir = await writeMigrations([
    {
      idx: 0,
      tag: "0000_deferred",
      statements: [
        `CREATE TABLE "bricx"."fx_deferred" ("id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL, "org_id" uuid NOT NULL, "k" text NOT NULL, CONSTRAINT "fx_deferred_k" UNIQUE ("org_id", "k") DEFERRABLE INITIALLY DEFERRED)`,
        `CREATE TABLE "bricx"."fx_immediate" ("id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL, "org_id" uuid NOT NULL, "k" text NOT NULL, CONSTRAINT "fx_immediate_k" UNIQUE ("org_id", "k"))`,
        `ALTER TABLE "bricx"."fx_deferred" ENABLE ROW LEVEL SECURITY`,
        `ALTER TABLE "bricx"."fx_deferred" FORCE ROW LEVEL SECURITY`,
        `CREATE POLICY "fx_deferred_org" ON "bricx"."fx_deferred" USING ("org_id" = ${ORG_SETTING}) WITH CHECK ("org_id" = ${ORG_SETTING})`,
        `ALTER TABLE "bricx"."fx_immediate" ENABLE ROW LEVEL SECURITY`,
        `ALTER TABLE "bricx"."fx_immediate" FORCE ROW LEVEL SECURITY`,
        `CREATE POLICY "fx_immediate_org" ON "bricx"."fx_immediate" USING ("org_id" = ${ORG_SETTING}) WITH CHECK ("org_id" = ${ORG_SETTING})`,
      ],
    },
  ]);
  await migrate(urlFor("bricx_owner", "BRICX_OWNER_PASSWORD"), dir);
  db = openDatabase(urlFor("bricx_app", "BRICX_APP_PASSWORD"), {
    maxConnections: 2,
  });
});
afterAll(async () => {
  await db.close();
  await pg18.container.stop();
});

const rowsOf = (table: string) =>
  asAdmin(`SELECT k FROM bricx.${table} WHERE org_id = $1 ORDER BY k`, [ORG_A]);

describe("a COMMIT that fails after fn resolved (owner condition 3)", () => {
  test("a deferred unique violation at COMMIT is TransactionCommitError 23505; nothing is written", async () => {
    let resolved = false;
    const error: unknown = await db
      .withTx(ctxA, async (tx) => {
        await tx.execute(
          sql`INSERT INTO bricx.fx_deferred (org_id, k) VALUES (${ORG_A}, 'dup')`,
        );
        await tx.execute(
          sql`INSERT INTO bricx.fx_deferred (org_id, k) VALUES (${ORG_A}, 'dup')`,
        );
        resolved = true;
        return "done";
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(resolved).toBe(true);
    expect(error).toBeInstanceOf(TransactionCommitError);
    expect((error as TransactionCommitError).sqlstate).toBe("23505");
    expect(Object.keys(error as object)).toEqual(["sqlstate"]);
    expect((error as Error).message).toBe("transaction commit failed");
    expect(String(error)).not.toContain("fx_deferred");
    expect(await rowsOf("fx_deferred")).toEqual([]);
  });

  test("the same violation inside fn (an immediate constraint) is the driver's error, rethrown unchanged", async () => {
    const error: unknown = await db
      .withTx(ctxA, async (tx) => {
        await tx.execute(
          sql`INSERT INTO bricx.fx_immediate (org_id, k) VALUES (${ORG_A}, 'dup')`,
        );
        await tx.execute(
          sql`INSERT INTO bricx.fx_immediate (org_id, k) VALUES (${ORG_A}, 'dup')`,
        );
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).not.toBeInstanceOf(TransactionCommitError);
    // Drizzle's wrapper around node-postgres' error (its `cause`).
    expect((error as Error).cause).toMatchObject({ code: "23505" });
    expect(sqlstateOf(error)).toBe("23505");
    expect(await rowsOf("fx_immediate")).toEqual([]);
  });

  test("after a failed COMMIT the connection is usable: the next withTx() commits", async () => {
    await db.withTx(ctxA, (tx) =>
      tx.execute(
        sql`INSERT INTO bricx.fx_deferred (org_id, k) VALUES (${ORG_A}, 'ok')`,
      ),
    );
    expect(await rowsOf("fx_deferred")).toEqual([{ k: "ok" }]);
  });
});

describe("a backend terminated while its client is checked out (the Also line from PR #52)", () => {
  test("the statement after the termination rejects; the process lives; the next withTx() works", async () => {
    let pid = 0;
    const error: unknown = await db
      .withTx(ctxA, async (tx) => {
        const who = await tx.execute<{ pid: number }>(
          sql`SELECT pg_backend_pid() AS pid`,
        );
        pid = who.rows[0]?.pid ?? 0;
        await asAdmin("SELECT pg_terminate_backend($1)", [pid]);
        // Give the server's FIN time to reach the client: a listener on
        // the checked-out client is what keeps it from crashing Node.
        await new Promise((resolve) => setTimeout(resolve, 300));
        await tx.execute(sql`SELECT 1`);
        return "survived";
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(pid).toBeGreaterThan(0);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBe("survived");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const again = await db.withTx(ctxA, async (tx) => {
      const r = await tx.execute<{ one: number }>(sql`SELECT 1 AS one`);
      return r.rows[0]?.one;
    });
    expect(again).toBe(1);
  });

  test("an idle pooled connection terminated between transactions is replaced silently", async () => {
    const pid = await db.withTx(ctxA, async (tx) => {
      const r = await tx.execute<{ pid: number }>(
        sql`SELECT pg_backend_pid() AS pid`,
      );
      return r.rows[0]?.pid ?? 0;
    });
    await asAdmin("SELECT pg_terminate_backend($1)", [pid]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const again = await db.withTx(ctxA, async (tx) => {
      const r = await tx.execute<{ one: number }>(sql`SELECT 1 AS one`);
      return r.rows[0]?.one;
    });
    expect(again).toBe(1);
  });
});
