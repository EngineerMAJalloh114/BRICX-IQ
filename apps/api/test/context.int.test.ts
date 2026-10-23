// P4-03: TxRunner end to end against compose.yml's Postgres. The auth
// guard sets the identity from a real token (P5-02, test/support/auth.ts;
// this suite migrates only its probe table, so the user directory is the
// fixed test one), TxRunner opens withTx() with it, and
// RLS on a FORCE-RLS fixture table returns only that org's rows, also for
// parallel requests from different orgs, and on a one-connection pool
// where the second request queues while the first transaction is open.
import {
  type BootstrappedPostgres,
  appDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { loadApiConfig } from "@bricx/config/api";
import { type Database, openDatabase } from "@bricx/db/database";
import { migrate } from "@bricx/db/migrate";
import { Controller, Get, Inject } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { sql } from "drizzle-orm";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { NoPermission } from "../src/common/auth/can.decorator.js";
import { createApp } from "../src/app.js";
import { currentRequestContext } from "../src/common/db/request-context.js";
import { TxRunner } from "../src/common/db/tx-runner.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";
import {
  fixedRevocations,
  TestIssuer,
  bearer,
  fixedSessions,
  fixedUsers,
  roleGrants,
} from "./support/auth.js";

const ORG_A = "0199e1a0-0000-7000-8000-00000000000a";
const ORG_B = "0199e1a0-0000-7000-8000-00000000000b";
const USER = "0199e1a0-0000-7000-8000-000000000001";
const ORG = "NULLIF(current_setting('app.org_id', true), '')::uuid";

/** What each request did, in order, on the one-connection pool. */
const events: string[] = [];

@NoPermission("test-only probe")
@Controller({ path: "probe", version: "1" })
class ProbeController {
  constructor(@Inject(TxRunner) private readonly runner: TxRunner) {}

  @Get()
  async list() {
    return this.runner.run(async (tx) => {
      const r = await tx.execute<{ note: string; org: string; who: string }>(
        sql`SELECT note, current_setting('app.org_id') AS org, current_user AS who
            FROM bricx.tenant_probe ORDER BY note`,
      );
      return r.rows;
    });
  }

  /**
   * Holds the transaction open (pg_sleep) so the other request queues for
   * the one connection, then reads the request context AFTER the awaited
   * query, inside fn.
   */
  @Get("serial")
  async serial() {
    const id = currentRequestContext()?.correlationId ?? "none";
    events.push(`enter ${id}`);
    return this.runner.run(async (tx) => {
      events.push(`fn start ${id}`);
      await tx.execute(sql`SELECT pg_sleep(0.3)`);
      const r = await tx.execute<{ note: string; org_id: string }>(
        sql`SELECT note, org_id FROM bricx.tenant_probe ORDER BY note`,
      );
      const after = currentRequestContext();
      events.push(`fn end ${id}`);
      return {
        correlationId: after?.correlationId ?? null,
        orgId: after?.identity?.orgId ?? null,
        rows: r.rows,
      };
    });
  }
}

let pg: BootstrappedPostgres;
let issuer: TestIssuer;
let app: NestFastifyApplication;
const auth = new Map<string, Record<string, string>>();
const authFor = (org: string): Record<string, string> => {
  const headers = auth.get(org);
  if (headers === undefined) throw new Error(`no token for ${org}`);
  return headers;
};

/** The test-only auth wiring: real tokens, a fixed user, no grants. */
const authOptions = () => ({
  userDirectory: fixedUsers({}, USER),
  sessionTracker: fixedSessions(),
  grantsSource: roleGrants(),
});
let single: NestFastifyApplication | undefined;

const urlFor = (role: string, key: string) =>
  `postgres://${role}:${exampleValue(key)}@${pg.container.getHost()}:${String(pg.container.getMappedPort(5432))}/${appDatabase}`;

beforeAll(async () => {
  [pg, issuer] = await Promise.all([startPostgres(), TestIssuer.start()]);
  for (const org of [ORG_A, ORG_B]) {
    auth.set(
      org,
      bearer(await issuer.token({ sub: "probe-user", org_id: org })),
    );
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "bricx-p4-03-"));
  await mkdir(path.join(dir, "meta"));
  await writeFile(
    path.join(dir, "meta/_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [
        { idx: 0, version: "7", when: 1, tag: "0000_probe", breakpoints: true },
      ],
    }),
  );
  await writeFile(
    path.join(dir, "0000_probe.sql"),
    [
      `CREATE TABLE "bricx"."tenant_probe" ("id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL, "org_id" uuid NOT NULL, "note" text NOT NULL);`,
      `ALTER TABLE "bricx"."tenant_probe" ENABLE ROW LEVEL SECURITY;`,
      `ALTER TABLE "bricx"."tenant_probe" FORCE ROW LEVEL SECURITY;`,
      `CREATE POLICY "tenant_probe_org" ON "bricx"."tenant_probe" USING ("org_id" = ${ORG}) WITH CHECK ("org_id" = ${ORG});`,
    ].join("\n--> statement-breakpoint\n"),
  );
  await migrate(
    { reveal: () => urlFor("bricx_owner", "BRICX_OWNER_PASSWORD") },
    dir,
  );
  const seed = openDatabase({
    reveal: () => urlFor("bricx_app", "BRICX_APP_PASSWORD"),
  });
  try {
    for (const [org, note] of [
      [ORG_A, "a1"],
      [ORG_B, "b1"],
      [ORG_B, "b2"],
    ] as const) {
      await seed.withTx({ orgId: org, userId: USER, projectIds: [] }, (tx) =>
        tx.execute(
          sql`INSERT INTO bricx.tenant_probe (org_id, note) VALUES (${org}, ${note})`,
        ),
      );
    }
  } finally {
    await seed.close();
  }
  app = await createApp(
    loadApiConfig(
      apiEnv({
        ...issuer.env(),
        DATABASE_URL: urlFor("bricx_app", "BRICX_APP_PASSWORD"),
      }),
    ),
    {
      probes: fakeProbes(),
      revocationStore: fixedRevocations(),
      extraControllers: [ProbeController],
      ...authOptions(),
    },
  );
  await app.init();
});
afterAll(async () => {
  await app.close().catch(() => undefined);
  await single?.close().catch(() => undefined);
  await issuer.close();
  await pg.container.stop();
});

async function appConnections(): Promise<number> {
  const admin = await pg.admin();
  try {
    const r = await admin.query<{ n: string }>(
      "SELECT count(*) AS n FROM pg_stat_activity WHERE usename = 'bricx_app'",
    );
    return Number(r.rows[0]?.n ?? "-1");
  } finally {
    await admin.end();
  }
}

describe("TxRunner against Postgres", () => {
  test("each org's request sees only its own rows, as bricx_app, in parallel", async () => {
    const requests = Array.from({ length: 12 }, (_, i) =>
      app.inject({
        method: "GET",
        url: "/v1/probe",
        headers: authFor(i % 2 === 0 ? ORG_A : ORG_B),
      }),
    );
    const results = await Promise.all(requests);
    results.forEach((res, i) => {
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(
        i % 2 === 0
          ? [{ note: "a1", org: ORG_A, who: "bricx_app" }]
          : [
              { note: "b1", org: ORG_B, who: "bricx_app" },
              { note: "b2", org: ORG_B, who: "bricx_app" },
            ],
      );
    });
  });

  test("a request without a token never reaches the database: 401 unauthenticated (P5-02; session_expired before P5)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/probe" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ status: 401, code: "unauthenticated" });
    expect(res.body).not.toContain("tenant_probe");
  });

  test("on a one-connection pool, a queued request still sees its own context and org after the awaited query", async () => {
    const singleDb: Database = openDatabase(
      { reveal: () => urlFor("bricx_app", "BRICX_APP_PASSWORD") },
      { maxConnections: 1, timeoutMs: 10_000, queryTimeoutMs: 10_000 },
    );
    single = await createApp(
      loadApiConfig(
        apiEnv({
          ...issuer.env(),
          DATABASE_URL: urlFor("bricx_app", "BRICX_APP_PASSWORD"),
        }),
      ),
      {
        probes: fakeProbes(),
        revocationStore: fixedRevocations(),
        database: singleDb,
        extraControllers: [ProbeController],
        ...authOptions(),
      },
    );
    await single.init();
    events.length = 0;
    const [a, b] = await Promise.all([
      single.inject({
        method: "GET",
        url: "/v1/probe/serial",
        headers: { "x-request-id": "one-a", ...authFor(ORG_A) },
      }),
      single.inject({
        method: "GET",
        url: "/v1/probe/serial",
        headers: { "x-request-id": "one-b", ...authFor(ORG_B) },
      }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json()).toEqual({
      correlationId: "one-a",
      orgId: ORG_A,
      rows: [{ note: "a1", org_id: ORG_A }],
    });
    expect(b.json()).toEqual({
      correlationId: "one-b",
      orgId: ORG_B,
      rows: [
        { note: "b1", org_id: ORG_B },
        { note: "b2", org_id: ORG_B },
      ],
    });
    // Both requests were in their handlers before the first transaction
    // ended, and the transactions ran one after the other: the second
    // request queued for the connection while the first was open.
    const first = events[2]?.slice("fn start ".length) ?? "";
    const second = first === "one-a" ? "one-b" : "one-a";
    expect(events.slice(0, 2).sort()).toEqual(["enter one-a", "enter one-b"]);
    expect(events.slice(2)).toEqual([
      `fn start ${first}`,
      `fn end ${first}`,
      `fn start ${second}`,
      `fn end ${second}`,
    ]);
    // The app owns the pool and closes it (DatabaseModule).
    await single.close();
    single = undefined;
  });

  test("closing the app closes the request pool", async () => {
    expect(await appConnections()).toBeGreaterThan(0);
    await app.close();
    // pg_stat_activity drops a backend shortly after its client
    // disconnects, not at once: poll for up to 5 s, then require 0.
    await expect
      .poll(appConnections, { timeout: 5_000, interval: 100 })
      .toBe(0);
  });
});
