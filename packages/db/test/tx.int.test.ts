// P4-03: withTx() against compose.yml's Postgres with the real init folder.
// A FORCE-RLS fixture table (applied by the migrator as bricx_owner; the
// real tenant tables and the RLS framework come in P4-04/P4-05) proves:
// no context sees no rows, each org sees only its own, a cross-org write
// fails, and the context never outlives its transaction.
import {
  type BootstrappedPostgres,
  appDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Database, openDatabase } from "../src/database.js";
import { migrate } from "../src/migrate.js";
import {
  InvalidTxContextError,
  NestedTransactionError,
  type TxContext,
  contextStatement,
  validateTxContext,
} from "../src/tx.js";
import { writeMigrations } from "./fixture-migrations.js";

const ORG_A = "0199e1a0-0000-7000-8000-00000000000a";
const ORG_B = "0199e1a0-0000-7000-8000-00000000000b";
const ORG_C = "0199e1a0-0000-7000-8000-00000000000c";
const USER = "0199e1a0-0000-7000-8000-000000000001";
const PROJECT = "0199e1a0-0000-7000-8000-000000000010";

const ctxA: TxContext = { orgId: ORG_A, userId: USER, projectIds: [PROJECT] };
const ctxB: TxContext = { orgId: ORG_B, userId: USER, projectIds: [] };
const ctxC: TxContext = { orgId: ORG_C, userId: USER, projectIds: [] };

const ORG_SETTING = "NULLIF(current_setting('app.org_id', true), '')::uuid";

let pg18: BootstrappedPostgres;
let db: Database;
const opened: Database[] = [];

const urlFor = (role: "bricx_owner" | "bricx_app", password: string) => ({
  reveal: () =>
    `postgres://${role}:${password}@${pg18.container.getHost()}:${String(pg18.container.getMappedPort(5432))}/${appDatabase}`,
});
const appUrl = () => urlFor("bricx_app", exampleValue("BRICX_APP_PASSWORD"));
const ownerUrl = () =>
  urlFor("bricx_owner", exampleValue("BRICX_OWNER_PASSWORD"));

function open(options: Parameters<typeof openDatabase>[1] = {}): Database {
  const handle = openDatabase(appUrl(), options);
  opened.push(handle);
  return handle;
}

/** A raw bricx_app client: no withTx(), so no app.* settings at all. */
async function rawApp<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: appUrl().reveal() });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function adminCount(): Promise<Record<string, number>> {
  const admin = await pg18.admin();
  try {
    const r = await admin.query<{ org_id: string; n: string }>(
      "SELECT org_id, count(*) AS n FROM bricx.tenant_probe GROUP BY org_id ORDER BY org_id",
    );
    return Object.fromEntries(r.rows.map((row) => [row.org_id, Number(row.n)]));
  } finally {
    await admin.end();
  }
}

async function notes(tx: Parameters<Parameters<Database["withTx"]>[1]>[0]) {
  const r = await tx.execute<{ org_id: string; note: string }>(
    sql`SELECT org_id, note FROM bricx.tenant_probe ORDER BY note`,
  );
  return r.rows.map((row) => `${row.org_id.slice(-1)}:${row.note}`);
}

beforeAll(async () => {
  pg18 = await startPostgres();
  // The fixture tenant table, applied by the real migrator as bricx_owner:
  // FORCE RLS, one policy with USING and WITH CHECK on app.org_id.
  await migrate(
    ownerUrl(),
    await writeMigrations([
      {
        idx: 0,
        tag: "0000_tenant_probe",
        statements: [
          `CREATE TABLE "bricx"."tenant_probe" (
            "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
            "org_id" uuid NOT NULL,
            "note" text NOT NULL
          );`,
          `ALTER TABLE "bricx"."tenant_probe" ENABLE ROW LEVEL SECURITY;`,
          `ALTER TABLE "bricx"."tenant_probe" FORCE ROW LEVEL SECURITY;`,
          `CREATE POLICY "tenant_probe_org" ON "bricx"."tenant_probe"
            USING ("org_id" = ${ORG_SETTING})
            WITH CHECK ("org_id" = ${ORG_SETTING});`,
        ],
      },
    ]),
  );
  db = open();
  // Rows are seeded under each org's own context (change 3).
  await db.withTx(ctxA, (tx) =>
    tx.execute(
      sql`INSERT INTO bricx.tenant_probe (org_id, note) VALUES (${ORG_A}, 'a1'), (${ORG_A}, 'a2')`,
    ),
  );
  await db.withTx(ctxB, (tx) =>
    tx.execute(
      sql`INSERT INTO bricx.tenant_probe (org_id, note) VALUES (${ORG_B}, 'b1')`,
    ),
  );
});
afterAll(async () => {
  await Promise.allSettled(opened.map((handle) => handle.close()));
  await pg18.container.stop();
});

describe("no context (Done when)", () => {
  test("a bricx_app query with no context returns zero rows from the tenant table", async () => {
    expect(await adminCount()).toEqual({ [ORG_A]: 2, [ORG_B]: 1 });
    await rawApp(async (client) => {
      const outside = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM bricx.tenant_probe",
      );
      expect(outside.rows[0]?.n).toBe("0");
      await client.query("BEGIN");
      const inside = await client.query<{ n: string; who: string }>(
        "SELECT count(*) AS n, current_user AS who FROM bricx.tenant_probe",
      );
      await client.query("COMMIT");
      expect(inside.rows[0]).toEqual({ n: "0", who: "bricx_app" });
    });
  });

  test("a bricx_app INSERT with no context fails the policy", async () => {
    await rawApp(async (client) => {
      await expect(
        client.query(
          "INSERT INTO bricx.tenant_probe (org_id, note) VALUES ($1, 'x')",
          [ORG_A],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });
    expect(await adminCount()).toEqual({ [ORG_A]: 2, [ORG_B]: 1 });
  });
});

describe("withTx(context, fn)", () => {
  test("each org sees only its own rows, as bricx_app, with its settings", async () => {
    expect(await db.withTx(ctxA, notes)).toEqual(["a:a1", "a:a2"]);
    expect(await db.withTx(ctxB, notes)).toEqual(["b:b1"]);
    expect(await db.withTx(ctxC, notes)).toEqual([]);
    const seen = await db.withTx(ctxA, async (tx) => {
      const r = await tx.execute<Record<string, string>>(
        sql`SELECT current_user AS who,
                   current_setting('app.org_id') AS org,
                   current_setting('app.user_id') AS usr,
                   current_setting('app.project_ids') AS projects,
                   current_setting('app.project_ids')::uuid[]::text AS cast,
                   current_setting('statement_timeout') AS timeout`,
      );
      return r.rows[0];
    });
    expect(seen).toEqual({
      who: "bricx_app",
      org: ORG_A,
      usr: USER,
      projects: `{${PROJECT}}`,
      cast: `{${PROJECT}}`,
      timeout: "30s",
    });
  });

  test("a cross-org INSERT fails WITH CHECK and writes nothing", async () => {
    const error = await db
      .withTx(ctxA, (tx) =>
        tx.execute(
          sql`INSERT INTO bricx.tenant_probe (org_id, note) VALUES (${ORG_B}, 'forged')`,
        ),
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toMatchObject({ cause: { code: "42501" } });
    expect(await adminCount()).toEqual({ [ORG_A]: 2, [ORG_B]: 1 });
  });

  test("a cross-org UPDATE touches no row and cannot move a row to another org", async () => {
    const updated = await db.withTx(ctxA, async (tx) => {
      const r = await tx.execute(
        sql`UPDATE bricx.tenant_probe SET note = 'hijacked' WHERE org_id = ${ORG_B}`,
      );
      return r.rowCount;
    });
    expect(updated).toBe(0);
    const moved = await db
      .withTx(ctxA, (tx) =>
        tx.execute(
          sql`UPDATE bricx.tenant_probe SET org_id = ${ORG_B} WHERE note = 'a1'`,
        ),
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(moved).toMatchObject({ cause: { code: "42501" } });
    expect(await db.withTx(ctxB, notes)).toEqual(["b:b1"]);
    expect(await db.withTx(ctxA, notes)).toEqual(["a:a1", "a:a2"]);
  });

  test("fn's error is rethrown unchanged and its writes roll back", async () => {
    const boom = new Error("boom");
    await expect(
      db.withTx(ctxA, async (tx) => {
        await tx.execute(
          sql`INSERT INTO bricx.tenant_probe (org_id, note) VALUES (${ORG_A}, 'rolled-back')`,
        );
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await adminCount()).toEqual({ [ORG_A]: 2, [ORG_B]: 1 });
  });

  test("returns fn's value", async () => {
    await expect(db.withTx(ctxC, () => Promise.resolve(42))).resolves.toBe(42);
  });

  test("the context is copied at the call: a later change by the caller has no effect", async () => {
    const ctx = { orgId: ORG_A, userId: USER, projectIds: [PROJECT] };
    const running = db.withTx(ctx, async (tx) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return notes(tx);
    });
    ctx.orgId = ORG_B;
    ctx.projectIds.push(ORG_C);
    expect(await running).toEqual(["a:a1", "a:a2"]);
  });

  test("a nested withTx() is refused; the outer transaction still decides", async () => {
    const inner = await db.withTx(ctxA, async () =>
      db.withTx(ctxB, notes).then(
        () => undefined,
        (e: unknown) => e,
      ),
    );
    expect(inner).toBeInstanceOf(NestedTransactionError);
    // Parallel calls outside any transaction are not nested.
    const both = await Promise.all([
      db.withTx(ctxA, notes),
      db.withTx(ctxB, notes),
    ]);
    expect(both).toEqual([["a:a1", "a:a2"], ["b:b1"]]);
  });

  test("statement_timeout bounds each statement (option statementTimeoutMs)", async () => {
    const quick = open({ statementTimeoutMs: 200 });
    const error = await quick
      .withTx(ctxC, (tx) => tx.execute(sql`SELECT pg_sleep(2)`))
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toMatchObject({ cause: { code: "57014" } });
  });
});

describe("the context never outlives its transaction", () => {
  test("withTx's context statement is transaction-local: after COMMIT the session sees none and no rows", async () => {
    await rawApp(async (client) => {
      // The exact statement withTx() runs, rendered as text and binds.
      const statement = new PgDialect().sqlToQuery(
        contextStatement(validateTxContext(ctxA), 30_000),
      );
      await client.query("BEGIN");
      await client.query(statement.sql, statement.params);
      const during = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM bricx.tenant_probe",
      );
      expect(during.rows[0]?.n).toBe("2");
      await client.query("COMMIT");
      const after = await client.query<{ n: string; org: string | null }>(
        "SELECT count(*) AS n, current_setting('app.org_id', true) AS org FROM bricx.tenant_probe",
      );
      // '' (not NULL) once set in the session: P4-04 policies use NULLIF.
      expect(after.rows[0]).toEqual({ n: "0", org: "" });
    });
  });

  test("on a one-connection pool, the next transaction sees only its own org", async () => {
    const single = open({ maxConnections: 1 });
    const pid = (tx: Parameters<Parameters<Database["withTx"]>[1]>[0]) =>
      tx
        .execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)
        .then((r) => r.rows[0]?.pid);
    const first = await single.withTx(ctxA, pid);
    expect(await single.withTx(ctxC, notes)).toEqual([]);
    expect(await single.withTx(ctxB, notes)).toEqual(["b:b1"]);
    expect(await single.withTx(ctxC, pid)).toBe(first);
  });
});

describe("refusals before any connection", () => {
  test("an invalid context is refused before connecting (the URL is unreachable)", async () => {
    const nowhere = openDatabase({
      reveal: () => "postgres://x:y@127.0.0.1:1/z",
    });
    opened.push(nowhere);
    const bad: TxContext = {
      orgId: "not-a-uuid",
      userId: USER,
      projectIds: [],
    };
    await expect(
      nowhere.withTx(bad, () => Promise.resolve(1)),
    ).rejects.toBeInstanceOf(InvalidTxContextError);
  });

  test("a connection failure is DatabaseUnavailableError with no detail, and fn never runs", async () => {
    const wrong = openDatabase({
      reveal: () =>
        appUrl()
          .reveal()
          .replace(exampleValue("BRICX_APP_PASSWORD"), "wrong-9"),
    });
    opened.push(wrong);
    let ran = false;
    const error = await wrong
      .withTx(ctxA, () => {
        ran = true;
        return Promise.resolve();
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(ran).toBe(false);
    expect(error).toMatchObject({
      name: "DatabaseUnavailableError",
      message: "database unavailable",
    });
    expect((error as Error).cause).toBeUndefined();
  });

  test("a closed handle refuses withTx()", async () => {
    const handle = open();
    await handle.close();
    await expect(
      handle.withTx(ctxA, () => Promise.resolve()),
    ).rejects.toMatchObject({ name: "DatabaseUnavailableError" });
  });
});
