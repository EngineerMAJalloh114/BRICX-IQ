// P5-07 (ADR 0068; Done-when DW5 and DW8, owner condition 2): the SoD
// history bricx.sod_actions and its database backstop, against compose.yml's
// Postgres with the production journal, applied by the real migrator as
// bricx_owner.
// - bricx.sod_actions: one row per action taken on a record chain (actor,
//   chain, record, type, action). A system tenant table (no catalogue
//   resource): ENABLE + FORCE, bricx_app SELECT and INSERT in its own org,
//   bricx_readonly SELECT; append-only for every role (statement triggers,
//   the owner included); not synced.
// - bricx.sod_conflict(): BEFORE INSERT FOR EACH ROW, generated from
//   SOD_RULES (@bricx/permissions sodConflictBody): it takes the chain's
//   advisory lock, then refuses a row whose actor already did a
//   counterpart on the same org and chain (23514, constraint
//   sod_actions_segregation), whoever inserts it.
// - @bricx/db/sod: lockSodChain(), sodHistory(), recordSodAction().
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type BootstrappedPostgres,
  type Role,
  appDatabase,
  exampleValue,
  rolePasswordKeys,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import {
  DEFAULT_MODEL,
  SOD_LOCK_NAMESPACE,
  generateAll,
  sodConflictBody,
} from "@bricx/permissions/generate";
import { LIMITS } from "@bricx/permissions/limits";
import { SOD_RULES } from "@bricx/permissions/sod";
import { PgDialect } from "drizzle-orm/pg-core";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Database, openDatabase, sqlstateOf } from "../src/database.js";
import { MIGRATIONS_DIR, migrate } from "../src/migrate.js";
import { APPEND_ONLY_TABLES } from "../src/rls-guard.js";
import {
  SYSTEM_APPEND_ONLY_TABLES,
  SYSTEM_TENANT_TABLES,
  TENANT_TABLES,
} from "../src/rls.js";
import {
  SodError,
  lockSodChain,
  recordSodAction,
  sodHistory,
} from "../src/sod.js";
import {
  type TxContext,
  contextStatement,
  validateTxContext,
} from "../src/tx.js";

const ORG_A = "0199e1b0-0000-7000-8000-0000000000a1";
const ORG_B = "0199e1b0-0000-7000-8000-0000000000b1";
const PROJECT = "0199e1b0-0000-7000-8000-0000000000a3";
const TABLE = "bricx.sod_actions";
const DENIED = "42501";
const CHECK = "23514";
const T0 = "2026-10-23T10:00:00.000Z";
const dialect = new PgDialect();

let pg18: BootstrappedPostgres;
let app: Database;
let n = 0;
/** A UUIDv7-shaped id (version 7, variant 10), unique per call. */
const nextId = (): string => {
  n += 1;
  return `0199e1b0-${n.toString(16).padStart(4, "0")}-7000-8000-${randomUUID().slice(-12)}`;
};

const urlFor = (role: Role) => ({
  reveal: () =>
    `postgres://${role}:${exampleValue(rolePasswordKeys[role])}@${pg18.container.getHost()}:${String(pg18.container.getMappedPort(5432))}/${appDatabase}`,
});

async function asAdmin<R extends pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  const admin = await pg18.admin();
  try {
    return (await admin.query<R>(text, params)).rows;
  } finally {
    await admin.end();
  }
}

/** "ok:<rowCount>" or the SQLSTATE, as the test superuser, rolled back. */
async function adminOutcome(text: string, params: unknown[] = []) {
  const admin = await pg18.admin();
  try {
    await admin.query("BEGIN");
    try {
      const r = await admin.query(text, params);
      return `ok:${String(r.rowCount)}`;
    } catch (error) {
      return sqlstateOf(error) ?? "?";
    } finally {
      await admin.query("ROLLBACK");
    }
  } finally {
    await admin.end();
  }
}

async function setContext(client: pg.Client, ctx: TxContext): Promise<void> {
  const q = dialect.sqlToQuery(
    contextStatement(validateTxContext(ctx), 30_000),
  );
  await client.query(q.sql, q.params);
}

/** Runs `run` as `who`, in a rolled-back transaction, with withTx()'s context. */
async function inTx<T>(
  who: Role,
  ctx: TxContext | undefined,
  run: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = await pg18.connectAs(who);
  try {
    await client.query("BEGIN");
    try {
      if (ctx !== undefined) await setContext(client, ctx);
      return await run(client);
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    await client.end();
  }
}

/** "ok:<rowCount>" or the SQLSTATE of one statement as `who`. */
const outcome = (
  who: Role,
  ctx: TxContext | undefined,
  text: string,
  params: unknown[] = [],
) =>
  inTx(who, ctx, (client) =>
    client.query(text, params).then(
      (r) => `ok:${String(r.rowCount)}`,
      (error: unknown) => sqlstateOf(error) ?? "?",
    ),
  );

const users = {
  alice: nextId(),
  bob: nextId(),
  carol: nextId(),
} as const;

async function insertUser(id: string) {
  await asAdmin(
    "INSERT INTO bricx.users (id, keycloak_sub, created_at, last_seen_at) VALUES ($1, $2, $3, $3)",
    [id, `sub-${id}`, T0],
  );
}

interface Action {
  readonly org?: string;
  readonly chain: string;
  readonly record?: string;
  readonly key: string;
  readonly actor: string;
}

const INSERT = `INSERT INTO bricx.sod_actions
  (id, org_id, chain_id, record_id, record_type, action, actor_id, project_id, created_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;

/** Splits "finance.payment.request" into ("finance.payment", "request"). */
const split = (key: string): [string, string] => {
  const at = key.lastIndexOf(".");
  return [key.slice(0, at), key.slice(at + 1)];
};

const paramsOf = (a: Action): unknown[] => {
  const [type, action] = split(a.key);
  return [
    nextId(),
    a.org ?? ORG_A,
    a.chain,
    a.record ?? a.chain,
    type,
    action,
    a.actor,
    PROJECT,
    T0,
  ];
};

const ctxA = (user: string): TxContext => ({
  orgId: ORG_A,
  userId: user,
  projectIds: [PROJECT],
});

/** Inserts `actions` in order as bricx_app in org A (rolled back); the last one's outcome. */
const lastOutcome = (actions: readonly Action[]) =>
  inTx("bricx_app", ctxA(users.alice), async (client) => {
    let last = "";
    for (const a of actions) {
      last = await client.query(INSERT, paramsOf(a)).then(
        (r) => `ok:${String(r.rowCount)}`,
        (error: unknown) => {
          const state = sqlstateOf(error) ?? "?";
          const constraint: unknown =
            typeof error === "object" && error !== null
              ? Reflect.get(error, "constraint")
              : undefined;
          return typeof constraint === "string"
            ? `${state}:${constraint}`
            : state;
        },
      );
    }
    return last;
  });

beforeAll(async () => {
  pg18 = await startPostgres();
  await migrate(urlFor("bricx_owner"));
  app = openDatabase(urlFor("bricx_app"));
  for (const id of Object.values(users)) await insertUser(id);
});
afterAll(async () => {
  await app.close();
  await pg18.container.stop();
});

describe("bricx.sod_actions: the table (DW8)", () => {
  test("columns, as the schema declares them", async () => {
    const columns = await asAdmin<{
      name: string;
      type: string;
      nullable: string;
    }>(
      `SELECT column_name AS name, data_type AS type, is_nullable AS nullable
       FROM information_schema.columns
       WHERE table_schema = 'bricx' AND table_name = 'sod_actions'
       ORDER BY ordinal_position`,
    );
    expect(columns).toEqual([
      { name: "id", type: "uuid", nullable: "NO" },
      { name: "org_id", type: "uuid", nullable: "NO" },
      { name: "chain_id", type: "uuid", nullable: "NO" },
      { name: "record_id", type: "uuid", nullable: "NO" },
      { name: "record_type", type: "text", nullable: "NO" },
      { name: "action", type: "text", nullable: "NO" },
      { name: "actor_id", type: "uuid", nullable: "NO" },
      { name: "project_id", type: "uuid", nullable: "YES" },
      { name: "created_at", type: "timestamp with time zone", nullable: "NO" },
    ]);
  });

  test("actor_id references bricx.users (23503); record_type and action are catalogue-shaped (23514)", async () => {
    const chain = nextId();
    expect(
      await adminOutcome(
        INSERT,
        paramsOf({ chain, key: "finance.payment.request", actor: nextId() }),
      ),
    ).toBe("23503");
    expect(
      await adminOutcome(
        INSERT,
        paramsOf({ chain, key: "Finance.payment.request", actor: users.alice }),
      ),
    ).toBe(CHECK);
    expect(
      await adminOutcome(
        INSERT,
        paramsOf({ chain, key: "finance.payment.Request", actor: users.alice }),
      ),
    ).toBe(CHECK);
  });

  test("registered: a system tenant table (no catalogue resource), append-only for the migrator's guard", () => {
    expect(SYSTEM_TENANT_TABLES).toHaveProperty([TABLE], "sod");
    expect(TENANT_TABLES).not.toHaveProperty([TABLE]);
    expect(SYSTEM_APPEND_ONLY_TABLES).toContain(TABLE);
    expect(APPEND_ONLY_TABLES).toContain(TABLE);
  });

  test("ENABLE + FORCE; bricx_app SELECT and INSERT in its org, bricx_readonly SELECT, nothing else; not synced (nothing for powersync_repl or bricx_relay, no publication)", async () => {
    expect(
      await asAdmin(
        "SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE oid = $1::regclass",
        [TABLE],
      ),
    ).toEqual([{ enabled: true, forced: true }]);
    const policies = await asAdmin<{
      name: string;
      cmd: string;
      roles: string[];
      qual: string | null;
      check: string | null;
    }>(`
      SELECT policyname AS name, cmd, roles::text[] AS roles, qual, with_check AS check
      FROM pg_policies WHERE schemaname = 'bricx' AND tablename = 'sod_actions'
      ORDER BY policyname`);
    for (const p of policies) p.roles.sort();
    const org = "(org_id = app.current_org())";
    expect(policies).toEqual([
      {
        name: "sod_actions_app_insert",
        cmd: "INSERT",
        roles: ["bricx_app"],
        qual: null,
        check: org,
      },
      {
        name: "sod_actions_select",
        cmd: "SELECT",
        roles: ["bricx_app", "bricx_readonly"],
        qual: org,
        check: null,
      },
    ]);
    const privileges = await asAdmin<{ role: string; p: string }>(
      `SELECT r.rolname AS role, string_agg(x.p, ',' ORDER BY x.p) AS p
       FROM pg_roles r, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS x(p)
       WHERE r.rolname IN ('bricx_app','bricx_readonly','bricx_relay','powersync_repl')
         AND has_table_privilege(r.rolname, $1::regclass, x.p)
       GROUP BY r.rolname ORDER BY r.rolname`,
      [TABLE],
    );
    expect(privileges).toEqual([
      { role: "bricx_app", p: "INSERT,SELECT" },
      { role: "bricx_readonly", p: "SELECT" },
    ]);
    expect(
      await asAdmin(
        "SELECT 1 FROM pg_publication_tables WHERE schemaname = 'bricx' AND tablename = 'sod_actions'",
      ),
    ).toEqual([]);
  });

  test("append-only for every role: UPDATE, DELETE and TRUNCATE are 42501 as bricx_app and as the superuser", async () => {
    const chain = nextId();
    const ctx = ctxA(users.alice);
    expect(
      await outcome(
        "bricx_app",
        ctx,
        INSERT,
        paramsOf({ chain, key: "field.dailylog.create", actor: users.alice }),
      ),
    ).toBe("ok:1");
    for (const text of [
      "UPDATE bricx.sod_actions SET action = 'approve'",
      "DELETE FROM bricx.sod_actions",
      "TRUNCATE bricx.sod_actions",
    ]) {
      expect(await outcome("bricx_app", ctx, text), text).toBe(DENIED);
      expect(await adminOutcome(text), text).toBe(DENIED);
    }
  });

  test("org isolation: org B's context sees none of org A's rows; INSERT for another org is 42501", async () => {
    const chain = nextId();
    const counts = await inTx(
      "bricx_app",
      ctxA(users.alice),
      async (client) => {
        await client.query(
          INSERT,
          paramsOf({ chain, key: "field.dailylog.create", actor: users.alice }),
        );
        const count = async (): Promise<number> => {
          const r = await client.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM bricx.sod_actions WHERE chain_id = $1",
            [chain],
          );
          return r.rows[0]?.n ?? -1;
        };
        const inA = await count();
        // Same transaction, org B's context: the row is there, unseen.
        await setContext(client, {
          orgId: ORG_B,
          userId: users.alice,
          projectIds: [],
        });
        return [inA, await count()];
      },
    );
    expect(counts).toEqual([1, 0]);
    expect(
      await outcome(
        "bricx_app",
        { orgId: ORG_B, userId: users.alice, projectIds: [] },
        INSERT,
        paramsOf({ chain, key: "field.dailylog.create", actor: users.alice }),
      ),
    ).toBe(DENIED);
  });
});

describe("bricx.sod_conflict(): the SoD backstop, generated from SOD_RULES (DW5, owner condition 2)", () => {
  const sides = SOD_RULES.flatMap((r) => [
    { attempted: r.second, earlier: r.first, rule: r.id },
    { attempted: r.first, earlier: r.second, rule: r.id },
  ]);

  test("the cases come from SOD_RULES: every pair, both directions", () => {
    expect(SOD_RULES.length).toBeGreaterThan(0);
    expect(sides).toHaveLength(SOD_RULES.length * 2);
  });

  test.each(sides)(
    "$rule: $earlier then $attempted by the same actor on the same chain is refused (23514 sod_actions_segregation); another actor or another chain passes",
    async ({ attempted, earlier }) => {
      const chain = nextId();
      expect(
        await lastOutcome([
          { chain, key: earlier, actor: users.alice },
          { chain, key: attempted, actor: users.alice },
        ]),
      ).toBe(`${CHECK}:sod_actions_segregation`);
      expect(
        await lastOutcome([
          { chain, key: earlier, actor: users.alice },
          { chain, key: attempted, actor: users.bob },
        ]),
      ).toBe("ok:1");
      expect(
        await lastOutcome([
          { chain, key: earlier, actor: users.alice },
          { chain: nextId(), key: attempted, actor: users.alice },
        ]),
      ).toBe("ok:1");
    },
  );

  test("an action outside every pair, and the same action twice, pass", async () => {
    const chain = nextId();
    expect(
      await lastOutcome([
        { chain, key: "project.task.create", actor: users.alice },
        { chain, key: "project.task.update", actor: users.alice },
      ]),
    ).toBe("ok:1");
    expect(
      await lastOutcome([
        { chain, key: "finance.payment.request", actor: users.alice },
        { chain, key: "finance.payment.request", actor: users.alice },
      ]),
    ).toBe("ok:1");
  });

  test("the service bypassed: the superuser's INSERT is refused too (the trigger fires for every role)", async () => {
    const chain = nextId();
    const admin = await pg18.admin();
    try {
      await admin.query("BEGIN");
      await admin.query(
        INSERT,
        paramsOf({ chain, key: "finance.payment.request", actor: users.carol }),
      );
      let caught: unknown;
      try {
        await admin.query(
          INSERT,
          paramsOf({
            chain,
            key: "finance.payment.approve",
            actor: users.carol,
          }),
        );
      } catch (error) {
        caught = error;
      }
      expect(sqlstateOf(caught)).toBe(CHECK);
      expect(caught).toMatchObject({ constraint: "sod_actions_segregation" });
    } finally {
      await admin.query("ROLLBACK");
      await admin.end();
    }
  });

  test("drift: the live function body is sodConflictBody(SOD_RULES); migration 0008 holds generated sod.sql verbatim; the trigger is BEFORE INSERT FOR EACH ROW and enabled", async () => {
    const [fn] = await asAdmin<{
      src: string;
      definer: boolean;
      config: string[] | null;
    }>(
      `SELECT prosrc AS src, prosecdef AS definer, proconfig AS config
       FROM pg_proc WHERE oid = 'bricx.sod_conflict()'::regprocedure`,
    );
    expect(fn?.src).toBe(sodConflictBody(DEFAULT_MODEL));
    expect(fn?.definer).toBe(false);
    expect(fn?.config).toEqual(["search_path=pg_catalog"]);
    const migration = await readFile(
      path.join(MIGRATIONS_DIR, "0008_sod_actions.sql"),
      "utf8",
    );
    expect(migration).toContain(generateAll()["sod.sql"].trimEnd());
    const triggers = await asAdmin<{
      name: string;
      def: string;
      enabled: string;
    }>(
      `SELECT tgname AS name, pg_get_triggerdef(oid) AS def, tgenabled AS enabled
       FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal ORDER BY tgname`,
      [TABLE],
    );
    expect(triggers).toEqual([
      {
        name: "sod_actions_no_truncate",
        def: "CREATE TRIGGER sod_actions_no_truncate BEFORE TRUNCATE ON bricx.sod_actions FOR EACH STATEMENT EXECUTE FUNCTION bricx.append_only()",
        enabled: "O",
      },
      {
        name: "sod_actions_no_update_delete",
        def: "CREATE TRIGGER sod_actions_no_update_delete BEFORE DELETE OR UPDATE ON bricx.sod_actions FOR EACH STATEMENT EXECUTE FUNCTION bricx.append_only()",
        enabled: "O",
      },
      {
        name: "sod_actions_segregation",
        def: "CREATE TRIGGER sod_actions_segregation BEFORE INSERT ON bricx.sod_actions FOR EACH ROW EXECUTE FUNCTION bricx.sod_conflict()",
        enabled: "O",
      },
    ]);
  });

  test("concurrency: one actor inserting both sides of a pair from two transactions at once gets exactly one success (the chain lock serialises them)", async () => {
    const chain = nextId();
    const first = await pg18.connectAs("bricx_app");
    const second = await pg18.connectAs("bricx_app");
    try {
      await first.query("BEGIN");
      await setContext(first, ctxA(users.bob));
      await second.query("BEGIN");
      await setContext(second, ctxA(users.bob));
      await first.query(
        INSERT,
        paramsOf({ chain, key: "finance.payment.request", actor: users.bob }),
      );
      // The second insert waits on the chain lock the first one holds.
      const pending = second
        .query(
          INSERT,
          paramsOf({ chain, key: "finance.payment.approve", actor: users.bob }),
        )
        .then(
          () => "ok",
          (error: unknown) => sqlstateOf(error) ?? "?",
        );
      let waiting = false;
      for (let i = 0; i < 200 && !waiting; i += 1) {
        const rows = await asAdmin<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks
           WHERE locktype = 'advisory' AND NOT granted AND classid = $1::oid`,
          [SOD_LOCK_NAMESPACE],
        );
        waiting = rows[0]?.n === 1;
      }
      expect(waiting).toBe(true);
      await first.query("COMMIT");
      expect(await pending).toBe(CHECK);
      await second.query("ROLLBACK");
    } finally {
      await first.end();
      await second.end();
    }
    const [row] = await asAdmin<{ n: number }>(
      "SELECT count(*)::int AS n FROM bricx.sod_actions WHERE chain_id = $1",
      [chain],
    );
    expect(row).toEqual({ n: 1 });
  });
});

describe("@bricx/db/sod: lockSodChain(), sodHistory(), recordSodAction()", () => {
  test("recordSodAction writes one row in the caller's transaction; sodHistory reads the chain oldest first as checkSod's entries", async () => {
    const chain = nextId();
    const record = nextId();
    const ctx = ctxA(users.alice);
    const history = await app.withTx(ctx, async (tx) => {
      await lockSodChain(tx, chain);
      await recordSodAction(tx, {
        chainId: chain,
        recordId: record,
        recordType: "finance.payment",
        action: "request",
        actorId: users.alice,
        projectId: PROJECT,
        at: T0,
      });
      await recordSodAction(tx, {
        chainId: chain,
        recordId: record,
        recordType: "finance.payment",
        action: "approve",
        actorId: users.bob,
        projectId: PROJECT,
        at: T0,
      });
      return sodHistory(tx, chain);
    });
    expect(history).toEqual([
      {
        chainId: chain,
        recordId: record,
        recordType: "finance.payment",
        action: "request",
        actorId: users.alice,
      },
      {
        chainId: chain,
        recordId: record,
        recordType: "finance.payment",
        action: "approve",
        actorId: users.bob,
      },
    ]);
    // Rolled back with its transaction: nothing stays.
    await expect(
      app.withTx(ctx, async (tx) => {
        await recordSodAction(tx, {
          chainId: nextId(),
          recordId: nextId(),
          recordType: "field.dailylog",
          action: "create",
          actorId: users.alice,
          projectId: PROJECT,
          at: T0,
        });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
  });

  test("a conflicting row is SodError sod_violation (the trigger's refusal, never a raw 23514)", async () => {
    const chain = nextId();
    let caught: unknown;
    try {
      await app.withTx(ctxA(users.carol), async (tx) => {
        const base = {
          chainId: chain,
          recordId: chain,
          recordType: "finance.payment",
          actorId: users.carol,
          projectId: PROJECT,
          at: T0,
        };
        await recordSodAction(tx, { ...base, action: "request" });
        await recordSodAction(tx, { ...base, action: "approve" });
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SodError);
    expect(caught).toMatchObject({ code: "sod_violation" });
  });

  test("sodHistory reads at most LIMITS.sodHistory + 1 rows (so checkSod sees an overflow); ids are checked before any SQL", async () => {
    const chain = nextId();
    const ctx = ctxA(users.alice);
    const count = await app.withTx(ctx, async (tx) => {
      for (let i = 0; i < LIMITS.sodHistory + 2; i += 1) {
        await recordSodAction(tx, {
          chainId: chain,
          recordId: nextId(),
          recordType: "project.task",
          action: "create",
          actorId: users.alice,
          projectId: PROJECT,
          at: T0,
        });
      }
      return (await sodHistory(tx, chain)).length;
    });
    expect(count).toBe(LIMITS.sodHistory + 1);
    for (const bad of ["not-a-uuid", ""]) {
      let caught: unknown;
      try {
        await app.withTx(ctx, (tx) => sodHistory(tx, bad));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SodError);
      expect(caught).toMatchObject({ code: "invalid_id" });
    }
  });
});
