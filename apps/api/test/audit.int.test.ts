// P4-05 (ADR 0055): hash-chained audit events against compose.yml's
// Postgres with the real init folder and the production journal.
// - Append-only (condition 1): statement-level BEFORE UPDATE OR DELETE and
//   BEFORE TRUNCATE triggers raise 42501 for bricx_owner too, on an empty
//   table and on one with rows; bricx_app lacks UPDATE, DELETE, TRUNCATE.
// - AuditService.record(): one chain per org, sha256(prev ‖ JCS(row))
//   checked by an independent oracle, in the caller's transaction (rolled
//   back with it), serialised by the per-org advisory lock (20 parallel
//   appends), refused outside a tenant context and outside READ COMMITTED
//   (condition 4).
// - audit:verify (the built CLI): an untouched chain exits 0; each hashed
//   column edited by the superuser fails at that row (condition 3), and so
//   do an edited prev_hash or hash, a deleted row and two swapped rows.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { loadApiConfig } from "@bricx/config/api";
import {
  type BootstrappedPostgres,
  appDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { type Database, openDatabase } from "@bricx/db/database";
import { migrate } from "@bricx/db/migrate";
import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  HttpCode,
  Inject,
  Injectable,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { setIdentity } from "../src/common/db/request-context.js";
import { TxRunner } from "../src/common/db/tx-runner.js";
import {
  AuditContextError,
  AuditIsolationError,
  AuditService,
  type AuditEventInput,
  type AuditOriginInput,
  verifyAuditChain,
} from "../src/modules/audit/public-api.js";
import { ORACLE_GENESIS, oracleHash, oracleRow } from "./audit-oracle.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";

const appDir = path.resolve(import.meta.dirname, "..");
const outDir = path.join(appDir, "dist");
const USER = "0199e1a0-0000-7000-8000-000000000001";
const DEVICE = "0199e1a0-0000-7000-8000-0000000000de";
const DENIED = "42501";
const START = Date.UTC(2026, 9, 16, 10, 20, 26, 123);

let pg18: BootstrappedPostgres;
let db: Database;
let now = START;
const clock = { now: () => (now += 1) };
const service = new AuditService(clock);

const urlFor = (role: string, key: string) =>
  `postgres://${role}:${exampleValue(key)}@${pg18.container.getHost()}:${String(pg18.container.getMappedPort(5432))}/${appDatabase}`;
const appUrl = () => urlFor("bricx_app", "BRICX_APP_PASSWORD");
const ctx = (orgId: string) => ({ orgId, userId: USER, projectIds: [] });

const eventN = (n: number): AuditEventInput => ({
  action: "project.task.update",
  entityType: "project.task",
  entityId: "0199e1a0-0000-7000-8000-0000000000e1",
  before: {
    title: `Task ${String(n - 1)}`,
    amount: { minor: "150000", currency: "SLE" },
  },
  after: {
    title: `Task ${String(n)}`,
    amount: { minor: "175000", currency: "SLE" },
  },
});
const originN = (n: number): AuditOriginInput => ({
  correlationId: `req-${String(n)}`,
  ip: "203.0.113.7",
  deviceId: DEVICE,
  geo: { latE6: 8_484_146, lonE6: -13_234_442 },
});

/** Records events 1..count for `org`, one transaction each, in order. */
async function recordChain(org: string, count = 5): Promise<void> {
  for (let n = 1; n <= count; n += 1) {
    await db.withTx(ctx(org), (tx) =>
      service.record(tx, eventN(n), originN(n)),
    );
  }
}

async function asAdmin<R extends Record<string, unknown>>(
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

/**
 * Runs each statement with `params` as the superuser, with triggers off
 * (session_replication_role = replica).
 */
async function tamper(
  statements: string[],
  params: unknown[] = [],
): Promise<void> {
  const admin = await pg18.admin();
  try {
    await admin.query("SET session_replication_role = replica");
    for (const text of statements) await admin.query(text, params);
  } finally {
    await admin.end();
  }
}

type StoredRow = {
  id: string;
  org_id: string;
  seq: string;
  hash_version: number;
  occurred_at: string;
  actor_type: string;
  actor_id: string | null;
  device_id: string | null;
  ip: string | null;
  geo: unknown;
  correlation_id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  prev_hash: Buffer;
  hash: Buffer;
};

/** Every row of `org` as the superuser reads it (no RLS), in seq order. */
const rowsOf = (org: string) =>
  asAdmin<StoredRow>(
    `SELECT id, org_id, seq::text AS seq, hash_version,
            to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at,
            actor_type, actor_id, device_id, ip::text AS ip, geo, correlation_id,
            action, entity_type, entity_id, before, after, prev_hash, hash
     FROM bricx.audit_events WHERE org_id = $1 ORDER BY audit_events.seq`,
    [org],
  );

/** "ok:<rowCount>" or the SQLSTATE, as `role`, in a rolled-back transaction. */
async function outcome(
  role: "bricx_owner" | "bricx_app" | "bricx_readonly",
  org: string | undefined,
  text: string,
): Promise<string> {
  const client = await pg18.connectAs(role);
  try {
    await client.query("BEGIN");
    try {
      if (org !== undefined) {
        await client.query(
          "SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)",
          [org, USER],
        );
      }
      const result = await client.query(text);
      return `ok:${String(result.rowCount)}`;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error) {
        return String(error.code);
      }
      throw error;
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    await client.end();
  }
}

/** Runs the built audit:verify CLI. */
function runVerify(
  args: string[],
  env: Record<string, string> = apiEnv({ DATABASE_URL: appUrl() }),
): Promise<{ code: number | null; output: string }> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      path.join(outDir, "register.js"),
      path.join(outDir, "audit-verify.js"),
      ...args,
    ],
    {
      cwd: appDir,
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: "pipe",
    },
  );
  let output = "";
  child.stdout.on("data", (d: Buffer) => (output += d.toString("utf8")));
  child.stderr.on("data", (d: Buffer) => (output += d.toString("utf8")));
  return new Promise((resolve) => {
    child.on("close", (code) => {
      resolve({ code, output });
    });
  });
}

beforeAll(async () => {
  execFileSync(
    process.execPath,
    [
      path.resolve(appDir, "../../node_modules/typescript/bin/tsc"),
      "-p",
      path.join(appDir, "tsconfig.build.json"),
    ],
    { cwd: appDir, stdio: "pipe" },
  );
  pg18 = await startPostgres();
  await migrate({
    reveal: () => urlFor("bricx_owner", "BRICX_OWNER_PASSWORD"),
  });
  db = openDatabase({ reveal: appUrl }, { maxConnections: 25 });
});
afterAll(async () => {
  await db.close();
  await pg18.container.stop();
});

describe("append-only (D13, condition 1)", () => {
  const update = "UPDATE bricx.audit_events SET action = action";
  const remove = "DELETE FROM bricx.audit_events";
  const truncate = "TRUNCATE bricx.audit_events";

  // Runs first: the table is still empty.
  test("on an empty table, bricx_owner UPDATE, DELETE and TRUNCATE raise 42501", async () => {
    expect(await asAdmin("SELECT 1 FROM bricx.audit_events")).toEqual([]);
    for (const org of [undefined, randomUUID()]) {
      expect(await outcome("bricx_owner", org, update)).toBe(DENIED);
      expect(await outcome("bricx_owner", org, remove)).toBe(DENIED);
      expect(await outcome("bricx_owner", org, truncate)).toBe(DENIED);
    }
  });

  test("on a table with rows, bricx_owner and bricx_app are refused, and nothing changes", async () => {
    const org = randomUUID();
    await recordChain(org, 3);
    const before = await rowsOf(org);
    for (const scope of [undefined, org]) {
      expect(await outcome("bricx_owner", scope, update)).toBe(DENIED);
      expect(await outcome("bricx_owner", scope, remove)).toBe(DENIED);
      expect(
        await outcome("bricx_owner", scope, `${remove} WHERE seq = 1`),
      ).toBe(DENIED);
      expect(await outcome("bricx_owner", scope, truncate)).toBe(DENIED);
    }
    for (const role of ["bricx_app", "bricx_readonly"] as const) {
      expect(await outcome(role, org, update)).toBe(DENIED);
      expect(await outcome(role, org, remove)).toBe(DENIED);
      expect(await outcome(role, org, truncate)).toBe(DENIED);
    }
    expect(await rowsOf(org)).toEqual(before);
  });

  test("the triggers are statement-level BEFORE triggers, enabled, on UPDATE, DELETE and TRUNCATE", async () => {
    const triggers = await asAdmin<{
      name: string;
      def: string;
      enabled: string;
    }>(
      `SELECT tgname AS name, pg_get_triggerdef(oid) AS def, tgenabled AS enabled
       FROM pg_trigger WHERE tgrelid = 'bricx.audit_events'::regclass AND NOT tgisinternal
       ORDER BY tgname`,
    );
    expect(triggers.map((t) => t.name)).toEqual([
      "audit_events_no_truncate",
      "audit_events_no_update_delete",
    ]);
    for (const t of triggers) {
      expect(t.enabled).toBe("O");
      expect(t.def).toContain("FOR EACH STATEMENT");
      expect(t.def).not.toContain("FOR EACH ROW");
      expect(t.def).toMatch(/ BEFORE /);
    }
    expect(triggers[0]?.def).toMatch(/BEFORE TRUNCATE ON bricx\.audit_events/);
    expect(triggers[1]?.def).toMatch(
      /BEFORE (?:UPDATE OR DELETE|DELETE OR UPDATE) ON bricx\.audit_events/,
    );
  });
});

describe("AuditService.record()", () => {
  test("the first event: seq 1, linked to genesis, hash equal to the oracle's over the stored row", async () => {
    const org = randomUUID();
    now = START;
    const result = await db.withTx(ctx(org), (tx) =>
      service.record(tx, eventN(1), originN(1)),
    );
    const [row, ...rest] = await rowsOf(org);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      org_id: org,
      seq: "1",
      hash_version: 1,
      occurred_at: new Date(START + 1).toISOString(),
      actor_type: "user",
      actor_id: USER,
      device_id: DEVICE,
      ip: "203.0.113.7/32",
      geo: { lat_e6: 8_484_146, lon_e6: -13_234_442 },
      correlation_id: "req-1",
      action: "project.task.update",
      entity_type: "project.task",
      entity_id: "0199e1a0-0000-7000-8000-0000000000e1",
      before: eventN(1).before,
      after: eventN(1).after,
    });
    if (row === undefined) throw new Error("no row");
    expect(row.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(row.prev_hash).toEqual(Buffer.from(ORACLE_GENESIS));
    expect(row.hash).toEqual(oracleHash(ORACLE_GENESIS, oracleRow(row)));
    expect(result).toEqual({
      id: row.id,
      seq: "1",
      hash: row.hash.toString("hex"),
    });
  });

  test("five events form one chain: each prev_hash is the previous hash, each hash the oracle's", async () => {
    const org = randomUUID();
    await recordChain(org);
    const rows = await rowsOf(org);
    expect(rows.map((r) => r.seq)).toEqual(["1", "2", "3", "4", "5"]);
    let prev: Buffer = Buffer.from(ORACLE_GENESIS);
    for (const row of rows) {
      expect(row.prev_hash).toEqual(prev);
      expect(row.hash).toEqual(oracleHash(prev, oracleRow(row)));
      prev = row.hash;
    }
  });

  test("outside a request and with no origin: a fresh UUIDv7 correlation id, no ip, device or geo", async () => {
    const org = randomUUID();
    await db.withTx(ctx(org), (tx) => service.record(tx, eventN(1)));
    const [row] = await rowsOf(org);
    expect(row?.correlation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(row).toMatchObject({ ip: null, device_id: null, geo: null });
  });

  test("geo survives a real jsonb round trip as integer micro-degrees, and verifies", async () => {
    const org = randomUUID();
    await recordChain(org, 2);
    const typed = await asAdmin<{ lat: string; lon: string; v: string }>(
      `SELECT jsonb_typeof(geo->'lat_e6') AS lat, jsonb_typeof(geo->'lon_e6') AS lon,
              geo::text AS v
       FROM bricx.audit_events WHERE org_id = $1 AND seq = 1`,
      [org],
    );
    expect(typed).toEqual([
      {
        lat: "number",
        lon: "number",
        v: '{"lat_e6": 8484146, "lon_e6": -13234442}',
      },
    ]);
    expect((await rowsOf(org))[0]?.geo).toEqual({
      lat_e6: 8_484_146,
      lon_e6: -13_234_442,
    });
    expect((await runVerify(["--org", org])).code).toBe(0);
  });

  test("ip is stored as a host address (/32 or /128) and hashed in its inet::text form", async () => {
    const org = randomUUID();
    const ips = ["203.0.113.7", "2001:DB8:0:0::1", "::ffff:203.0.113.7"];
    for (const [i, ip] of ips.entries()) {
      await db.withTx(ctx(org), (tx) =>
        service.record(tx, eventN(i + 1), { ...originN(i + 1), ip }),
      );
    }
    const stored = await asAdmin<{
      text: string;
      mask: number;
      family: number;
    }>(
      `SELECT ip::text AS text, masklen(ip) AS mask, family(ip) AS family
       FROM bricx.audit_events WHERE org_id = $1 ORDER BY seq`,
      [org],
    );
    expect(stored).toEqual([
      { text: "203.0.113.7/32", mask: 32, family: 4 },
      { text: "2001:db8::1/128", mask: 128, family: 6 },
      { text: "::ffff:203.0.113.7/128", mask: 128, family: 6 },
    ]);
    const [first, second] = await rowsOf(org);
    if (first === undefined || second === undefined) throw new Error("no rows");
    expect(second.ip).toBe("2001:db8::1/128");
    expect(second.hash).toEqual(oracleHash(first.hash, oracleRow(second)));
    expect((await runVerify(["--org", org])).code).toBe(0);
  });

  test("it is part of the caller's transaction: a rollback leaves no event, and the next one is seq 1", async () => {
    const org = randomUUID();
    await expect(
      db.withTx(ctx(org), async (tx) => {
        await service.record(tx, eventN(1), originN(1));
        throw new Error("the request failed after recording");
      }),
    ).rejects.toThrow("the request failed after recording");
    expect(await rowsOf(org)).toEqual([]);
    await recordChain(org, 1);
    expect((await rowsOf(org)).map((r) => r.seq)).toEqual(["1"]);
  });

  test("refused outside a tenant context (no app.org_id), before any write", async () => {
    const client = await pg18.connectAs("bricx_app");
    try {
      const orm = drizzle({ client });
      await expect(
        orm.transaction((tx) => service.record(tx, eventN(1), originN(1))),
      ).rejects.toBeInstanceOf(AuditContextError);
    } finally {
      await client.end();
    }
  });

  test.each(["repeatable read", "serializable"] as const)(
    "refused in a %s transaction (condition 4), and nothing is written",
    async (isolationLevel) => {
      const org = randomUUID();
      const client = await pg18.connectAs("bricx_app");
      try {
        const orm = drizzle({ client });
        const error = await orm
          .transaction(
            async (tx) => {
              await tx.execute(
                sql`SELECT set_config('app.org_id', ${org}, true), set_config('app.user_id', ${USER}, true)`,
              );
              await service.record(tx, eventN(1), originN(1));
            },
            { isolationLevel },
          )
          .then(
            () => undefined,
            (e: unknown) => e,
          );
        expect(error).toBeInstanceOf(AuditIsolationError);
        expect(error).toMatchObject({
          code: "audit.isolation_not_read_committed",
        });
      } finally {
        await client.end();
      }
      expect(await rowsOf(org)).toEqual([]);
    },
  );

  test("an invalid event is refused before any write", async () => {
    const org = randomUUID();
    await expect(
      db.withTx(ctx(org), (tx) =>
        service.record(
          tx,
          { ...eventN(1), after: { amount: 1.5 } },
          originN(1),
        ),
      ),
    ).rejects.toMatchObject({ code: "audit.invalid_event", field: "after" });
    expect(await rowsOf(org)).toEqual([]);
  });

  test("20 parallel appends in one org give seq 1..20 and one valid chain", async () => {
    const org = randomUUID();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        db.withTx(ctx(org), (tx) =>
          service.record(tx, eventN(i + 1), originN(i + 1)),
        ),
      ),
    );
    const rows = await rowsOf(org);
    expect(rows.map((r) => r.seq)).toEqual(
      Array.from({ length: 20 }, (_, i) => String(i + 1)),
    );
    expect(await runVerify(["--org", org])).toMatchObject({ code: 0 });
  });

  test("two orgs appending in parallel keep two independent chains", async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        db.withTx(ctx(i % 2 === 0 ? a : b), (tx) =>
          service.record(tx, eventN(i + 1), originN(i + 1)),
        ),
      ),
    );
    for (const org of [a, b]) {
      expect((await rowsOf(org)).map((r) => r.seq)).toEqual(
        Array.from({ length: 10 }, (_, i) => String(i + 1)),
      );
      expect((await runVerify(["--org", org])).code).toBe(0);
    }
  });

  test("RLS: org B's transaction sees none of org A's events", async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await recordChain(a, 2);
    const seen = await db.withTx(ctx(b), (tx) =>
      tx.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM bricx.audit_events`,
      ),
    );
    expect(seen.rows).toEqual([{ n: "0" }]);
    const own = await db.withTx(ctx(a), (tx) =>
      tx.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM bricx.audit_events`,
      ),
    );
    expect(own.rows).toEqual([{ n: "2" }]);
  });

  test("verifyAuditChain reads in batches: batch size 3 over 20 events is intact", async () => {
    const org = randomUUID();
    await recordChain(org, 20);
    const rows = await rowsOf(org);
    const result = await db.withTx(ctx(org), (tx) =>
      verifyAuditChain(tx, { batchSize: 3 }),
    );
    expect(result).toEqual({
      status: "intact",
      events: 20,
      head: { seq: "20", hash: rows[19]?.hash.toString("hex") },
    });
  });
});

describe("audit:verify (the built CLI)", () => {
  test("an untouched chain exits 0 and prints the head", async () => {
    const org = randomUUID();
    await recordChain(org);
    const head = (await rowsOf(org))[4];
    expect(await runVerify(["--org", org])).toEqual({
      code: 0,
      output: `audit:verify: org ${org}: intact, 5 events, head seq 5 hash ${head?.hash.toString("hex") ?? ""}\n`,
    });
  });

  test("an org with no events exits 0", async () => {
    const org = randomUUID();
    expect(await runVerify(["--org", org])).toEqual({
      code: 0,
      output: `audit:verify: org ${org}: intact, 0 events\n`,
    });
  });

  test.each([
    [[]],
    [["--org"]],
    [["--org", "not-a-uuid"]],
    [["--org", "0199E1A0-0000-7000-8000-00000000000A"]],
    [["--org", "0199e1a0-0000-7000-8000-00000000000a", "--extra"]],
    [["--orgs", "0199e1a0-0000-7000-8000-00000000000a"]],
  ])("usage errors exit 2: %j", async (args) => {
    expect(await runVerify(args)).toEqual({
      code: 2,
      output: "audit:verify: usage: audit:verify --org <uuid>\n",
    });
  });

  test("a config error exits 2 naming the key, never the URL or password", async () => {
    const env = apiEnv({ DATABASE_URL: appUrl() });
    delete env.DATABASE_URL;
    const result = await runVerify(["--org", randomUUID()], env);
    expect(result.code).toBe(2);
    expect(result.output).toContain("DATABASE_URL");
    expect(result.output).not.toContain(exampleValue("BRICX_APP_PASSWORD"));
  });

  test("an unreachable database exits 2 with database_unavailable and no URL", async () => {
    const url = `postgres://bricx_app:${exampleValue("BRICX_APP_PASSWORD")}@127.0.0.1:1/${appDatabase}`;
    const result = await runVerify(
      ["--org", randomUUID()],
      apiEnv({ DATABASE_URL: url }),
    );
    expect(result).toEqual({
      code: 2,
      output: "audit:verify: database_unavailable\n",
    });
  });
});

// Condition 3: each hashed column edited alone, by the superuser with the
// triggers off, fails audit:verify at that row (seq 3 of 5).
describe("tampering (condition 3)", () => {
  const cases: [column: string, set: string, reason: string, at: number][] = [
    ["id", "id = uuidv7()", "hash_mismatch", 3],
    ["org_id", "org_id = uuidv7()", "seq_gap", 3],
    ["seq", "seq = 300", "seq_gap", 3],
    [
      "occurred_at",
      "occurred_at = occurred_at + interval '1 millisecond'",
      "hash_mismatch",
      3,
    ],
    ["actor_type", "actor_type = 'system'", "hash_mismatch", 3],
    ["actor_id", "actor_id = uuidv7()", "hash_mismatch", 3],
    ["device_id", "device_id = uuidv7()", "hash_mismatch", 3],
    ["ip", "ip = '198.51.100.1'", "hash_mismatch", 3],
    [
      "geo",
      `geo = '{"lat_e6": 8484146, "lon_e6": -13234441}'`,
      "hash_mismatch",
      3,
    ],
    ["correlation_id", "correlation_id = 'req-tampered'", "hash_mismatch", 3],
    ["action", "action = 'project.task.delete'", "hash_mismatch", 3],
    ["entity_type", "entity_type = 'project.site'", "hash_mismatch", 3],
    ["entity_id", "entity_id = uuidv7()", "hash_mismatch", 3],
    ["before", `before = '{"title": "Task 9"}'`, "hash_mismatch", 3],
    [
      "after",
      `after = jsonb_set(after, '{amount,minor}', '"175001"')`,
      "hash_mismatch",
      3,
    ],
    ["hash_version", "hash_version = 2", "unknown_hash_version", 3],
    ["prev_hash", "prev_hash = sha256(prev_hash)", "prev_hash_mismatch", 3],
    ["hash", "hash = sha256(hash)", "hash_mismatch", 3],
  ];

  test.each(cases)(
    "%s edited at seq 3 (%s): exits 1 naming seq 3, %s",
    async (_column, set, reason, at) => {
      const org = randomUUID();
      await recordChain(org);
      await tamper(
        [`UPDATE bricx.audit_events SET ${set} WHERE org_id = $1 AND seq = $2`],
        [org, at],
      );
      // The row the verifier finds at that position, as it now stands: the
      // edited row, or for a moved row (org_id, seq) the next one (a gap).
      const id = (await rowsOf(org))[at - 1]?.id;
      if (reason === "seq_gap") expect(id).not.toBe(undefined);
      expect(await runVerify(["--org", org])).toEqual({
        code: 1,
        output: `audit:verify: org ${org}: broken at seq ${String(at)} (id ${id ?? ""}): ${reason}\n`,
      });
    },
  );

  test("the untouched copies of those chains still verify (control)", async () => {
    const org = randomUUID();
    await recordChain(org);
    await tamper(
      [
        "UPDATE bricx.audit_events SET action = action WHERE org_id = $1 AND seq = 3",
      ],
      [org],
    );
    expect((await runVerify(["--org", org])).code).toBe(0);
  });

  test("a deleted middle row: seq_gap at 3", async () => {
    const org = randomUUID();
    await recordChain(org);
    const fourth = (await rowsOf(org))[3];
    await tamper(
      ["DELETE FROM bricx.audit_events WHERE org_id = $1 AND seq = 3"],
      [org],
    );
    expect(await runVerify(["--org", org])).toEqual({
      code: 1,
      output: `audit:verify: org ${org}: broken at seq 3 (id ${fourth?.id ?? ""}): seq_gap\n`,
    });
  });

  test("two swapped rows (2 and 3): fails at seq 2 with prev_hash_mismatch", async () => {
    const org = randomUUID();
    await recordChain(org);
    const third = (await rowsOf(org))[2];
    await tamper(
      [
        "UPDATE bricx.audit_events SET seq = 1000 WHERE org_id = $1 AND seq = 2",
        "UPDATE bricx.audit_events SET seq = 2 WHERE org_id = $1 AND seq = 3",
        "UPDATE bricx.audit_events SET seq = 3 WHERE org_id = $1 AND seq = 1000",
      ],
      [org],
    );
    expect(await runVerify(["--org", org])).toEqual({
      code: 1,
      output: `audit:verify: org ${org}: broken at seq 2 (id ${third?.id ?? ""}): prev_hash_mismatch\n`,
    });
  });
});

/** Stands in for P5's auth guard: sets the identity from test headers. */
@Injectable()
class TestIdentityGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const org = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>().headers[
      "x-test-org"
    ];
    if (org !== undefined) {
      setIdentity({ orgId: org, userId: USER, projectIds: [], roles: [] });
    }
    return true;
  }
}

@Controller({ path: "audit-probe", version: "1" })
@UseGuards(TestIdentityGuard)
class AuditProbeController {
  constructor(
    @Inject(TxRunner) private readonly runner: TxRunner,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Post()
  @HttpCode(201)
  async create() {
    return this.runner.run((tx) =>
      this.audit.record(tx, {
        action: "project.task.create",
        entityType: "project.task",
      }),
    );
  }
}

describe("wired into the API (AuditModule, TxRunner, the request context)", () => {
  let app: NestFastifyApplication | undefined;
  afterAll(async () => {
    await app?.close();
  });

  test("a request records an event with its correlation id, ip, device and user", async () => {
    app = await createApp(loadApiConfig(apiEnv({ DATABASE_URL: appUrl() })), {
      probes: fakeProbes(),
      extraControllers: [AuditProbeController],
      extraProviders: [TestIdentityGuard],
    });
    await app.init();
    const org = randomUUID();
    const res = await app.inject({
      method: "POST",
      url: "/v1/audit-probe",
      headers: {
        "x-test-org": org,
        "x-request-id": "e2e-req-1",
        "x-device-id": DEVICE,
      },
    });
    expect(res.statusCode).toBe(201);
    const rows = await rowsOf(org);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      seq: "1",
      actor_type: "user",
      actor_id: USER,
      correlation_id: "e2e-req-1",
      ip: "127.0.0.1/32",
      device_id: DEVICE,
      geo: null,
      action: "project.task.create",
      entity_type: "project.task",
      entity_id: null,
      before: null,
      after: null,
    });
    expect(res.json()).toEqual({
      id: rows[0]?.id,
      seq: "1",
      hash: rows[0]?.hash.toString("hex"),
    });
  });
});
