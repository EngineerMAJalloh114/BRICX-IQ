// P4-06 (ADR 0056, condition 5): OutboxService.enqueue() is a thin wrapper
// over @bricx/db/outbox's insertOutbox(): it writes in the CALLER's
// transaction, so the outbox row commits or rolls back with the change it
// belongs to. The org comes from the transaction, the id is a UUIDv7 from
// the injected Clock. (The relay and its jobs are proved in apps/worker.)
import { randomUUID } from "node:crypto";
import { loadApiConfig } from "@bricx/config/api";
import {
  type BootstrappedPostgres,
  appDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { type Database, openDatabase } from "@bricx/db/database";
import { migrate } from "@bricx/db/migrate";
import { OutboxError } from "@bricx/db/outbox";
import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  HttpCode,
  Inject,
  Injectable,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { setIdentity } from "../src/common/db/request-context.js";
import { TxRunner } from "../src/common/db/tx-runner.js";
import { OutboxService } from "../src/modules/outbox/public-api.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";

const USER = "0199e1a0-0000-7000-8000-000000000001";
// 2026-10-16T14:05:00.000Z: the ids' 48-bit time prefix.
const START = Date.UTC(2026, 9, 16, 14, 5, 0, 0);

let pg18: BootstrappedPostgres;
let db: Database;
const clock = { now: () => START };
const service = new OutboxService(clock);

const urlFor = (role: string, key: string) =>
  `postgres://${role}:${exampleValue(key)}@${pg18.container.getHost()}:${String(pg18.container.getMappedPort(5432))}/${appDatabase}`;
const appUrl = () => urlFor("bricx_app", "BRICX_APP_PASSWORD");
const ctx = (orgId: string) => ({ orgId, userId: USER, projectIds: [] });

async function rowsOf(org: string) {
  const admin = await pg18.admin();
  try {
    return (
      await admin.query<{ id: string; topic: string; payload: unknown }>(
        "SELECT id::text, topic, payload FROM bricx.outbox WHERE org_id = $1 ORDER BY id",
        [org],
      )
    ).rows;
  } finally {
    await admin.end();
  }
}

beforeAll(async () => {
  pg18 = await startPostgres();
  await migrate({
    reveal: () => urlFor("bricx_owner", "BRICX_OWNER_PASSWORD"),
  });
  db = openDatabase({ reveal: appUrl });
});
afterAll(async () => {
  await db.close();
  await pg18.container.stop();
});

describe("OutboxService.enqueue(tx, topic, payload)", () => {
  test("commits with the caller's transaction: one row, the org from the tx, a UUIDv7 from the Clock", async () => {
    const org = randomUUID();
    const id = await db.withTx(ctx(org), (tx) =>
      service.enqueue(tx, "system.ping", {}),
    );
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(id.replaceAll("-", "").slice(0, 12)).toBe(
      START.toString(16).padStart(12, "0"),
    );
    expect(await rowsOf(org)).toEqual([
      { id, topic: "system.ping", payload: {} },
    ]);
  });

  test("rolls back with the caller's transaction: no row", async () => {
    const org = randomUUID();
    await expect(
      db.withTx(ctx(org), async (tx) => {
        await service.enqueue(tx, "system.ping", {});
        await service.enqueue(tx, "system.ping", {});
        throw new Error("the business change failed");
      }),
    ).rejects.toThrow("the business change failed");
    expect(await rowsOf(org)).toEqual([]);
  });

  test("refusals are insertOutbox()'s OutboxError, and nothing is written", async () => {
    const org = randomUUID();
    for (const [topic, payload, code] of [
      ["system.pong", {}, "unknown_topic"],
      ["system.ping", { a: 1.5 }, "invalid_payload"],
    ] as const) {
      const error = await db
        .withTx(ctx(org), (tx) => service.enqueue(tx, topic, payload))
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(OutboxError);
      expect((error as OutboxError).code).toBe(code);
    }
    expect(await rowsOf(org)).toEqual([]);
  });
});

/** Stands in for P5's auth guard: sets the identity from a test header. */
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

@Controller({ path: "outbox-probe", version: "1" })
@UseGuards(TestIdentityGuard)
class OutboxProbeController {
  constructor(
    @Inject(TxRunner) private readonly runner: TxRunner,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Query("fail") fail?: string) {
    return this.runner.run(async (tx) => {
      const id = await this.outbox.enqueue(tx, "system.ping", {});
      if (fail === "1") throw new Error("the business change failed");
      return { id };
    });
  }
}

describe("wired into the API (OutboxModule, TxRunner, the request context)", () => {
  let app: NestFastifyApplication | undefined;
  afterAll(async () => {
    await app?.close();
  });

  test("a request's row commits with the request transaction, and a failed request leaves none", async () => {
    app = await createApp(loadApiConfig(apiEnv({ DATABASE_URL: appUrl() })), {
      probes: fakeProbes(),
      extraControllers: [OutboxProbeController],
      extraProviders: [TestIdentityGuard],
    });
    await app.init();
    const org = randomUUID();
    const ok = await app.inject({
      method: "POST",
      url: "/v1/outbox-probe",
      headers: { "x-test-org": org },
    });
    expect(ok.statusCode).toBe(201);
    const { id } = ok.json<{ id: string }>();
    expect(await rowsOf(org)).toEqual([
      { id, topic: "system.ping", payload: {} },
    ]);

    const failed = await app.inject({
      method: "POST",
      url: "/v1/outbox-probe?fail=1",
      headers: { "x-test-org": org },
    });
    expect(failed.statusCode).toBe(500);
    expect(await rowsOf(org)).toHaveLength(1);
  });
});
