// P4-03: TxRunner end to end against compose.yml's Postgres. A guard sets
// the identity (P5's auth guard will), TxRunner opens withTx() with it, and
// RLS on a FORCE-RLS fixture table returns only that org's rows, also for
// parallel requests from different orgs.
import {
  type BootstrappedPostgres,
  appDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { loadApiConfig } from "@bricx/config/api";
import { openDatabase } from "@bricx/db/database";
import { migrate } from "@bricx/db/migrate";
import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  Inject,
  Injectable,
  UseGuards,
} from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { sql } from "drizzle-orm";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { setIdentity } from "../src/common/db/request-context.js";
import { TxRunner } from "../src/common/db/tx-runner.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";

const ORG_A = "0199e1a0-0000-7000-8000-00000000000a";
const ORG_B = "0199e1a0-0000-7000-8000-00000000000b";
const USER = "0199e1a0-0000-7000-8000-000000000001";
const ORG = "NULLIF(current_setting('app.org_id', true), '')::uuid";

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

@Controller({ path: "probe", version: "1" })
@UseGuards(TestIdentityGuard)
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
}

let pg: BootstrappedPostgres;
let app: NestFastifyApplication;

const urlFor = (role: string, key: string) =>
  `postgres://${role}:${exampleValue(key)}@${pg.container.getHost()}:${String(pg.container.getMappedPort(5432))}/${appDatabase}`;

beforeAll(async () => {
  pg = await startPostgres();
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
      apiEnv({ DATABASE_URL: urlFor("bricx_app", "BRICX_APP_PASSWORD") }),
    ),
    {
      probes: fakeProbes(),
      extraControllers: [ProbeController],
      extraProviders: [TestIdentityGuard],
    },
  );
  await app.init();
});
afterAll(async () => {
  await app.close().catch(() => undefined);
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
        headers: { "x-test-org": i % 2 === 0 ? ORG_A : ORG_B },
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

  test("a request without an identity never reaches the database (500)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/probe" });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("tenant_probe");
  });

  test("closing the app closes the request pool", async () => {
    expect(await appConnections()).toBeGreaterThan(0);
    await app.close();
    expect(await appConnections()).toBe(0);
  });
});
