// P4-07 (ADR 0057, owner condition 3; the Also line from PR #52): what a
// request gets when the database fails under it, against compose.yml's
// Postgres with the production journal.
// - A COMMIT that fails after the handler resolved (a DEFERRABLE
//   INITIALLY DEFERRED unique) is 409 request.conflict for 23505.
// - The same violation inside the handler (an immediate unique) is the
//   driver's error: 500 generic, the stack logged, nothing in the body.
// - A backend terminated under a checked-out client: 503, the process
//   lives, the next request works.
import { Writable } from "node:stream";
import { loadApiConfig } from "@bricx/config/api";
import {
  type BootstrappedPostgres,
  appDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { migrate } from "@bricx/db/migrate";
import { ErrorEnvelopeSchema } from "@bricx/validation/error-envelope";
import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  Inject,
  Injectable,
  Param,
  UseGuards,
} from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { setIdentity } from "../src/common/db/request-context.js";
import { TxRunner } from "../src/common/db/tx-runner.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";

const ORG_A = "0199e1a0-0000-7000-8000-00000000000a";
const USER = "0199e1a0-0000-7000-8000-000000000001";
const HOST_WORD = "fx_dup";

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

@Controller({ path: "dbfail", version: "1" })
@UseGuards(TestIdentityGuard)
class DbFailController {
  constructor(@Inject(TxRunner) private readonly runner: TxRunner) {}

  @Get("deferred/:k")
  deferred(@Param("k") k: string) {
    return this.runner.run(async (tx) => {
      await tx.execute(
        sql`INSERT INTO bricx.fx_dup_deferred (org_id, k) VALUES (app.current_org(), ${k})`,
      );
      await tx.execute(
        sql`INSERT INTO bricx.fx_dup_deferred (org_id, k) VALUES (app.current_org(), ${k})`,
      );
      return { resolved: true };
    });
  }

  @Get("immediate/:k")
  immediate(@Param("k") k: string) {
    return this.runner.run(async (tx) => {
      await tx.execute(
        sql`INSERT INTO bricx.fx_dup_immediate (org_id, k) VALUES (app.current_org(), ${k})`,
      );
      await tx.execute(
        sql`INSERT INTO bricx.fx_dup_immediate (org_id, k) VALUES (app.current_org(), ${k})`,
      );
      return { resolved: true };
    });
  }

  @Get("pid")
  pid() {
    return this.runner.run(async (tx) => {
      const r = await tx.execute<{ pid: number }>(
        sql`SELECT pg_backend_pid() AS pid`,
      );
      return { pid: r.rows[0]?.pid ?? 0 };
    });
  }

  /** Reports its backend pid, waits for the test to terminate it, then queries. */
  @Get("terminated")
  terminated() {
    return this.runner.run(async (tx) => {
      const r = await tx.execute<{ pid: number }>(
        sql`SELECT pg_backend_pid() AS pid`,
      );
      reportPid(r.rows[0]?.pid ?? 0);
      await terminated;
      await new Promise((resolve) => setTimeout(resolve, 300));
      await tx.execute(sql`SELECT 1`);
      return { survived: true };
    });
  }
}

let reportPid: (pid: number) => void = () => undefined;
let pidReported: Promise<number> = Promise.resolve(0);
let markTerminated: () => void = () => undefined;
let terminated: Promise<void> = Promise.resolve();

let pg18: BootstrappedPostgres;
let app: NestFastifyApplication;
const lines: string[] = [];

const urlFor = (role: string, key: string) =>
  `postgres://${role}:${exampleValue(key)}@${pg18.container.getHost()}:${String(pg18.container.getMappedPort(5432))}/${appDatabase}`;

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
  await migrate({
    reveal: () => urlFor("bricx_owner", "BRICX_OWNER_PASSWORD"),
  });
  for (const statement of [
    `CREATE TABLE bricx.fx_dup_deferred (id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL, org_id uuid NOT NULL, k text NOT NULL, CONSTRAINT fx_dup_deferred_k UNIQUE (org_id, k) DEFERRABLE INITIALLY DEFERRED)`,
    `CREATE TABLE bricx.fx_dup_immediate (id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL, org_id uuid NOT NULL, k text NOT NULL, CONSTRAINT fx_dup_immediate_k UNIQUE (org_id, k))`,
    `ALTER TABLE bricx.fx_dup_deferred ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE bricx.fx_dup_deferred FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY fx_dup_deferred_org ON bricx.fx_dup_deferred TO bricx_app USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org())`,
    `ALTER TABLE bricx.fx_dup_immediate ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE bricx.fx_dup_immediate FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY fx_dup_immediate_org ON bricx.fx_dup_immediate TO bricx_app USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org())`,
    `GRANT SELECT, INSERT ON bricx.fx_dup_deferred, bricx.fx_dup_immediate TO bricx_app`,
  ]) {
    await asAdmin(statement);
  }
  app = await createApp(
    loadApiConfig(
      apiEnv({ DATABASE_URL: urlFor("bricx_app", "BRICX_APP_PASSWORD") }),
    ),
    {
      probes: fakeProbes(),
      extraControllers: [DbFailController],
      extraProviders: [TestIdentityGuard],
      logStream: new Writable({
        write(chunk: Buffer, _encoding, done) {
          lines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
          done();
        },
      }),
    },
  );
  await app.init();
});
afterAll(async () => {
  await app.close().catch(() => undefined);
  await pg18.container.stop();
});

const logs = () =>
  lines.map((line) => JSON.parse(line) as Record<string, unknown>);

function expectProblem(
  res: { statusCode: number; headers: Record<string, unknown>; body: string },
  status: number,
  code: string,
) {
  expect(res.statusCode).toBe(status);
  expect(String(res.headers["content-type"])).toContain(
    "application/problem+json",
  );
  const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(res.body));
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error("not an envelope");
  expect(parsed.data).toMatchObject({ status, code, key: `errors:${code}` });
  expect(res.body).not.toContain(HOST_WORD);
}

const get = (path: string) =>
  app.inject({
    method: "GET",
    url: `/v1/dbfail/${path}`,
    headers: { "x-test-org": ORG_A },
  });

describe("database failures under a request", () => {
  test("a unique violation at COMMIT (deferred) is 409 request.conflict, logged at info with the SQLSTATE and without a stack", async () => {
    lines.length = 0;
    expectProblem(await get("deferred/a"), 409, "request.conflict");
    expect(await asAdmin("SELECT k FROM bricx.fx_dup_deferred")).toEqual([]);
    const rejected = logs().filter((l) => l.msg === "request.rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      level: 30,
      code: "request.conflict",
      status: 409,
      sqlstate: "23505",
    });
    expect(rejected[0]).not.toHaveProperty("err");
    expect(logs().filter((l) => l.msg === "request.failed")).toEqual([]);
  });

  test("the same violation inside the handler (immediate) is 500 generic, the driver's error logged with its stack and never in the body", async () => {
    lines.length = 0;
    const res = await get("immediate/b");
    expectProblem(res, 500, "generic");
    expect(res.body).not.toContain("23505");
    expect(await asAdmin("SELECT k FROM bricx.fx_dup_immediate")).toEqual([]);
    const failed = logs().filter((l) => l.msg === "request.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ sqlstate: "23505", code: "generic" });
    const err = failed[0]?.err as { message: string; stack: string };
    // Drizzle's wrapper, with the driver's error as its cause, both logged.
    expect(err.message).toContain("duplicate key");
    expect(err.stack).toContain("database.ts");
  });

  test("a backend terminated under the handler is 503 server_unavailable; the process lives; the next request works", async () => {
    pidReported = new Promise((resolve) => {
      reportPid = resolve;
    });
    terminated = new Promise((resolve) => {
      markTerminated = resolve;
    });
    const pending = get("terminated");
    const pid = await pidReported;
    expect(pid).toBeGreaterThan(0);
    await asAdmin("SELECT pg_terminate_backend($1)", [pid]);
    markTerminated();
    expectProblem(await pending, 503, "server_unavailable");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const next = await get("pid");
    expect(next.statusCode).toBe(200);
    expect(next.json<{ pid: number }>().pid).toBeGreaterThan(0);
    expect(next.json<{ pid: number }>().pid).not.toBe(pid);
  });

  test("an idle pooled connection terminated between requests is replaced silently", async () => {
    const { pid } = (await get("pid")).json<{ pid: number }>();
    await asAdmin("SELECT pg_terminate_backend($1)", [pid]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const next = await get("pid");
    expect(next.statusCode).toBe(200);
    expect(next.json<{ pid: number }>().pid).toBeGreaterThan(0);
  });
});
