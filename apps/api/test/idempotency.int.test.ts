// P4-07 (ADR 0057, decisions 5b and 6a, owner conditions 1, 5 and 6):
// @Idempotent() routes end to end against compose.yml's Postgres with the
// production journal. A replay is the stored text sent verbatim through
// the same response path (byte equality, a 201 + Location), headers from
// the allow-list only, the replay request's own x-request-id; a different
// body under the same key is 422; a concurrent duplicate waits on the
// unique index and gets the identical answer with one write; a failed
// handler leaves no key, so a retry writes; an expired key writes again;
// nothing is stored when the response is over 256 KiB.
import { randomUUID } from "node:crypto";
import { loadApiConfig } from "@bricx/config/api";
import {
  type BootstrappedPostgres,
  appDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { migrate } from "@bricx/db/migrate";
import { add, fromMinor } from "@bricx/money/money";
import { ErrorEnvelopeSchema } from "@bricx/validation/error-envelope";
import { Body, Controller, HttpCode, Inject, Post, Res } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { sql } from "drizzle-orm";
import { ZodResponse } from "nestjs-zod";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { Money } from "../src/common/dto/money.dto.js";
import { TxRunner } from "../src/common/db/tx-runner.js";
import {
  IDEMPOTENCY_KEY_HEADER,
  Idempotent,
  REPLAYED_HEADER,
} from "../src/common/idempotency/decorator.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";
import {
  fixedRevocations,
  TestIssuer,
  bearer,
  roleGrants,
  seedUsers,
} from "./support/auth.js";

const ORG_A = "0199e1a0-0000-7000-8000-00000000000a";
const ORG_B = "0199e1a0-0000-7000-8000-00000000000b";
const USER_1 = "0199e1a0-0000-7000-8000-000000000001";
const USER_2 = "0199e1a0-0000-7000-8000-000000000002";
const SECRET = "body-secret-never-in-an-error-2e9b";
const BIG = 262_144;

interface Reply {
  header(name: string, value: string): unknown;
}

interface Thing {
  name: string;
  zeta?: string;
  alpha?: string;
}

/** Opened by the test: the gate handler holds its transaction on it. */
let releaseGate: () => void = () => undefined;
let gate = Promise.resolve();
let enteredGate: () => void = () => undefined;
let entered = Promise.resolve();
function armGate() {
  gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  entered = new Promise((resolve) => {
    enteredGate = resolve;
  });
}

@Controller({ path: "idem", version: "1" })
class IdemController {
  constructor(@Inject(TxRunner) private readonly runner: TxRunner) {}

  private insert(
    tx: Parameters<Parameters<TxRunner["run"]>[0]>[0],
    name: string,
  ) {
    return tx
      .execute<{ id: string }>(
        sql`INSERT INTO bricx.idem_probe (org_id, name) VALUES (app.current_org(), ${name}) RETURNING id::text`,
      )
      .then((r) => r.rows[0]?.id ?? "");
  }

  /** 201 + Location; the body's keys are deliberately not alphabetical. */
  @Post("things")
  @Idempotent()
  create(@Body() body: Thing, @Res({ passthrough: true }) reply: Reply) {
    return this.runner.run(async (tx) => {
      const id = await this.insert(tx, body.name);
      reply.header("location", `/v1/idem/things/${id}`);
      return { zeta: body.zeta, id, alpha: body.alpha, name: body.name };
    });
  }

  /** 200 + ETag + a header outside the allow-list. */
  @Post("tagged")
  @Idempotent()
  @HttpCode(200)
  tagged(@Body() body: Thing, @Res({ passthrough: true }) reply: Reply) {
    return this.runner.run(async (tx) => {
      const id = await this.insert(tx, body.name);
      reply.header("etag", `"${id}"`);
      reply.header("x-not-replayed", "first-only");
      return { id };
    });
  }

  /** Writes, then waits for the test to release it (owner condition 5). */
  @Post("gate")
  @Idempotent()
  gated(@Body() body: Thing) {
    return this.runner.run(async (tx) => {
      const id = await this.insert(tx, body.name);
      enteredGate();
      await gate;
      return { id, name: body.name };
    });
  }

  @Post("fail")
  @Idempotent()
  fail(@Body() body: Thing) {
    return this.runner.run(async (tx) => {
      await this.insert(tx, body.name);
      throw new Error(`${SECRET} after writing`);
    });
  }

  @Post("big")
  @Idempotent()
  big(@Body() body: Thing) {
    return this.runner.run(async (tx) => {
      await this.insert(tx, body.name);
      return { data: "x".repeat(BIG) };
    });
  }

  @Post("twice")
  @Idempotent()
  async twice(@Body() body: Thing) {
    await this.runner.run((tx) => this.insert(tx, body.name));
    return this.runner.run((tx) => this.insert(tx, `${body.name}-2`));
  }

  @Post("none")
  @Idempotent()
  none(@Body() body: Thing) {
    return { name: body.name };
  }

  /** Money in, Money out (P4-08, owner condition 1): the wire form is stored. */
  @Post("money")
  @Idempotent()
  @ZodResponse({ status: 201, type: Money })
  money(@Body() body: Money) {
    return this.runner.run(async (tx) => {
      await this.insert(tx, `money-${body.currency}`);
      return add(body, body);
    });
  }

  /** A bigint without a response DTO cannot be stored (P4-08). */
  @Post("bigint")
  @Idempotent()
  bigint(@Body() body: Thing) {
    return this.runner.run(async (tx) => {
      await this.insert(tx, body.name);
      return { minor: 5n };
    });
  }

  @Post("plain")
  plain(@Body() body: Thing) {
    return this.runner.run(async (tx) => ({
      id: await this.insert(tx, body.name),
    }));
  }
}

let pg18: BootstrappedPostgres;
let app: NestFastifyApplication;
let n = 0;
const nextKey = (): string => {
  n += 1;
  return `key-${String(n)}-${randomUUID()}`;
};

const urlFor = (role: string, key: string) =>
  `postgres://${role}:${exampleValue(key)}@${pg18.container.getHost()}:${String(pg18.container.getMappedPort(5432))}/${appDatabase}`;

async function asAdmin<R extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  const admin = await pg18.admin();
  try {
    return (await admin.query(text, params)).rows as R[];
  } finally {
    await admin.end();
  }
}

const probeRows = (name: string) =>
  asAdmin<{ org_id: string; name: string }>(
    "SELECT org_id::text, name FROM bricx.idem_probe WHERE name = $1 ORDER BY org_id",
    [name],
  );

type KeyRow = {
  org_id: string;
  user_id: string;
  route: string;
  status: number;
  response: string | null;
  headers: Record<string, string> | null;
};
const keyRows = (key: string) =>
  asAdmin<KeyRow>(
    "SELECT org_id::text, user_id::text, route, status, response, headers FROM bricx.idempotency_keys WHERE key = $1 ORDER BY org_id, user_id",
    [key],
  );

let issuer: TestIssuer;
/** Bearer headers per `${org} ${user}` (real tokens, test/support). */
const auth = new Map<string, { authorization: string }>();
const SUBS: Record<string, string> = {
  [USER_1]: "idem-user-1",
  [USER_2]: "idem-user-2",
};

function authFor(org: string, user: string): { authorization: string } {
  const headers = auth.get(`${org} ${user}`);
  if (headers === undefined) throw new Error(`no token for ${org} ${user}`);
  return headers;
}

beforeAll(async () => {
  [pg18, issuer] = await Promise.all([startPostgres(), TestIssuer.start()]);
  await migrate({
    reveal: () => urlFor("bricx_owner", "BRICX_OWNER_PASSWORD"),
  });
  // The guard provisions through Postgres; the seeded rows fix the ids.
  await seedUsers(asAdmin, [
    { id: USER_1, sub: "idem-user-1" },
    { id: USER_2, sub: "idem-user-2" },
  ]);
  for (const org of [ORG_A, ORG_B]) {
    for (const user of [USER_1, USER_2]) {
      const token = await issuer.token({
        sub: SUBS[user],
        org_id: org,
        exp: Math.floor(Date.now() / 1000) + 3_600,
      });
      auth.set(`${org} ${user}`, bearer(token));
    }
  }
  // A FORCE-RLS tenant table the handlers write to (not part of the
  // production journal): created by the test superuser after migrate().
  for (const statement of [
    `CREATE TABLE bricx.idem_probe (id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL, org_id uuid NOT NULL, name text NOT NULL)`,
    `ALTER TABLE bricx.idem_probe ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE bricx.idem_probe FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY idem_probe_org ON bricx.idem_probe TO bricx_app USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org())`,
    `GRANT SELECT, INSERT ON bricx.idem_probe TO bricx_app`,
  ]) {
    await asAdmin(statement);
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
      extraControllers: [IdemController],
      grantsSource: roleGrants(),
    },
  );
  await app.init();
});
afterAll(async () => {
  await app.close().catch(() => undefined);
  await issuer.close();
  await pg18.container.stop();
});

interface PostOptions {
  key?: string | undefined;
  org?: string;
  user?: string;
  requestId?: string;
  contentType?: string;
}

function post(path: string, payload: unknown, options: PostOptions = {}) {
  const headers: Record<string, string> = {
    "content-type": options.contentType ?? "application/json",
    ...authFor(options.org ?? ORG_A, options.user ?? USER_1),
  };
  if (options.key !== undefined) headers[IDEMPOTENCY_KEY_HEADER] = options.key;
  if (options.requestId !== undefined)
    headers["x-request-id"] = options.requestId;
  return app.inject({
    method: "POST",
    url: `/v1/idem/${path}`,
    headers,
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

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
  expect(res.body).not.toContain(SECRET);
  expect(res.headers).not.toHaveProperty(REPLAYED_HEADER);
}

describe("@Idempotent() end to end (owner condition 1)", () => {
  test("the same key replays the 201 byte for byte: body, Location, content-type; its own x-request-id; one write; the stored text is the body", async () => {
    const key = nextKey();
    const name = `thing-${key}`;
    const body = { zeta: "z", name, alpha: "a" };
    const first = await post("things", body, { key, requestId: "req-first" });
    expect(first.statusCode).toBe(201);
    expect(first.headers["x-request-id"]).toBe("req-first");
    expect(first.headers).not.toHaveProperty(REPLAYED_HEADER);
    expect(first.headers.location).toMatch(
      /^\/v1\/idem\/things\/[0-9a-f-]{36}$/,
    );
    const created = first.json<{ id: string }>();
    // The handler's key order survives: zeta, id, alpha, name.
    expect(Object.keys(created)).toEqual(["zeta", "id", "alpha", "name"]);

    const replay = await post("things", body, { key, requestId: "req-replay" });
    expect(replay.statusCode).toBe(201);
    expect(
      Buffer.from(replay.rawPayload).equals(Buffer.from(first.rawPayload)),
    ).toBe(true);
    expect(replay.body).toBe(first.body);
    expect(replay.headers.location).toBe(first.headers.location);
    expect(replay.headers["content-type"]).toBe(first.headers["content-type"]);
    expect(replay.headers["x-request-id"]).toBe("req-replay");
    expect(replay.headers[REPLAYED_HEADER]).toBe("true");

    expect(await probeRows(name)).toEqual([{ org_id: ORG_A, name }]);
    const rows = await keyRows(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      org_id: ORG_A,
      user_id: USER_1,
      route: "POST /v1/idem/things",
      status: 201,
      response: first.body,
    });
    expect(rows[0]?.headers).toEqual({
      "content-type": "application/json; charset=utf-8",
      location: first.headers.location,
    });
  });

  test("the same key from another user of the same org, or another org, is a new request: two more writes", async () => {
    const key = nextKey();
    const name = `shared-${key}`;
    const a1 = await post("things", { name }, { key });
    const a2 = await post("things", { name }, { key, user: USER_2 });
    const b1 = await post("things", { name }, { key, org: ORG_B });
    for (const res of [a1, a2, b1]) {
      expect(res.statusCode).toBe(201);
      expect(res.headers).not.toHaveProperty(REPLAYED_HEADER);
    }
    expect(a1.json<{ id: string }>().id).not.toBe(a2.json<{ id: string }>().id);
    expect(await probeRows(name)).toEqual([
      { org_id: ORG_A, name },
      { org_id: ORG_A, name },
      { org_id: ORG_B, name },
    ]);
    expect(await keyRows(key)).toHaveLength(3);
  });

  test("the same key with a different body is 422 idempotency.key_reused, and writes nothing", async () => {
    const key = nextKey();
    const name = `reused-${key}`;
    expect((await post("things", { name }, { key })).statusCode).toBe(201);
    const res = await post("things", { name, zeta: SECRET }, { key });
    expectProblem(res, 422, "idempotency.key_reused");
    expect(await probeRows(name)).toHaveLength(1);
    // A different query string is a different request too.
    const q = await app.inject({
      method: "POST",
      url: "/v1/idem/things?dry=1",
      headers: {
        "content-type": "application/json",
        ...authFor(ORG_A, USER_1),
        [IDEMPOTENCY_KEY_HEADER]: key,
      },
      payload: JSON.stringify({ name }),
    });
    expectProblem(q, 422, "idempotency.key_reused");
    expect(await probeRows(name)).toHaveLength(1);
  });

  test("the same key on another route is a new request", async () => {
    const key = nextKey();
    const name = `route-${key}`;
    expect((await post("things", { name }, { key })).statusCode).toBe(201);
    expect((await post("tagged", { name }, { key })).statusCode).toBe(200);
    expect(await probeRows(name)).toHaveLength(2);
  });

  test("a concurrent duplicate waits on the unique index while the first transaction is open, then replays: one write, two identical answers (owner condition 5)", async () => {
    const key = nextKey();
    const name = `gate-${key}`;
    armGate();
    const first = post("gate", { name }, { key, requestId: "gate-first" });
    await entered;
    const second = post("gate", { name }, { key, requestId: "gate-second" });
    await expect
      .poll(
        async () => {
          const rows = await asAdmin<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE usename = 'bricx_app' AND wait_event_type = 'Lock'
               AND state = 'active' AND query ILIKE '%idempotency_keys%'`,
          );
          return rows[0]?.n ?? 0;
        },
        { timeout: 10_000, interval: 50 },
      )
      .toBe(1);
    // Nothing is committed while the gate holds.
    expect(await probeRows(name)).toEqual([]);
    releaseGate();
    const [a, b] = await Promise.all([first, second]);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.body).toBe(b.body);
    expect(a.headers).not.toHaveProperty(REPLAYED_HEADER);
    expect(b.headers[REPLAYED_HEADER]).toBe("true");
    expect(a.headers["x-request-id"]).toBe("gate-first");
    expect(b.headers["x-request-id"]).toBe("gate-second");
    expect(await probeRows(name)).toHaveLength(1);
    expect(await keyRows(key)).toHaveLength(1);
  });

  test("a handler that fails leaves no key: 500, nothing written, and the retry under the same key writes", async () => {
    const key = nextKey();
    const name = `fail-${key}`;
    expectProblem(await post("fail", { name }, { key }), 500, "generic");
    expect(await probeRows(name)).toEqual([]);
    expect(await keyRows(key)).toEqual([]);
    const retry = await post("things", { name }, { key });
    expect(retry.statusCode).toBe(201);
    expect(retry.headers).not.toHaveProperty(REPLAYED_HEADER);
    expect(await probeRows(name)).toHaveLength(1);
  });

  test("an expired key is a new request: the write happens again and the row is reused", async () => {
    const key = nextKey();
    const name = `expired-${key}`;
    const first = await post("things", { name }, { key });
    expect(first.statusCode).toBe(201);
    await asAdmin(
      "UPDATE bricx.idempotency_keys SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' WHERE key = $1",
      [key],
    );
    const again = await post("things", { name }, { key });
    expect(again.statusCode).toBe(201);
    expect(again.headers).not.toHaveProperty(REPLAYED_HEADER);
    expect(again.json<{ id: string }>().id).not.toBe(
      first.json<{ id: string }>().id,
    );
    expect(await probeRows(name)).toHaveLength(2);
    const rows = await keyRows(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.response).toBe(again.body);
  });

  test("a missing or invalid key is 400 and writes nothing", async () => {
    const name = `nokey-${randomUUID()}`;
    expectProblem(
      await post("things", { name }, {}),
      400,
      "idempotency.key_missing",
    );
    expectProblem(
      await post("things", { name }, { key: "not valid" }),
      400,
      "idempotency.key_invalid",
    );
    expect(await probeRows(name)).toEqual([]);
  });

  test("a route without @Idempotent() ignores the header: two writes", async () => {
    const key = nextKey();
    const name = `plain-${key}`;
    const a = await post("plain", { name }, { key });
    const b = await post("plain", { name }, { key });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.headers).not.toHaveProperty(REPLAYED_HEADER);
    expect(a.json<{ id: string }>().id).not.toBe(b.json<{ id: string }>().id);
    expect(await probeRows(name)).toHaveLength(2);
    expect(await keyRows(key)).toEqual([]);
  });

  test("a handler that opens run() twice, or never, is 500: nothing is kept", async () => {
    const key = nextKey();
    const name = `twice-${key}`;
    expectProblem(await post("twice", { name }, { key }), 500, "generic");
    const key2 = nextKey();
    expectProblem(await post("none", { name }, { key: key2 }), 500, "generic");
    expect(await keyRows(key2)).toEqual([]);
  });

  test("a response over 256 KiB fails before COMMIT: 500 idempotency.response_too_large, no write, no key", async () => {
    const key = nextKey();
    const name = `big-${key}`;
    expectProblem(
      await post("big", { name }, { key }),
      500,
      "idempotency.response_too_large",
    );
    expect(await probeRows(name)).toEqual([]);
    expect(await keyRows(key)).toEqual([]);
  });

  test("a non-JSON body on an @Idempotent() route is 415 (owner condition 6)", async () => {
    const key = nextKey();
    expectProblem(
      await post("things", SECRET, { key, contentType: "text/plain" }),
      415,
      "request.unsupported_media_type",
    );
    expect(await keyRows(key)).toEqual([]);
  });

  test("without a token: 401 unauthenticated, no key (P5-02; session_expired before P5)", async () => {
    const key = nextKey();
    const res = await app.inject({
      method: "POST",
      url: "/v1/idem/things",
      headers: {
        "content-type": "application/json",
        [IDEMPOTENCY_KEY_HEADER]: key,
      },
      payload: JSON.stringify({ name: "anon" }),
    });
    expectProblem(res, 401, "unauthenticated");
    expect(await keyRows(key)).toEqual([]);
  });

  test("an @Idempotent() route returning Money stores and replays the wire form byte for byte (P4-08, owner condition 1)", async () => {
    const key = nextKey();
    const first = await post(
      "money",
      { amount: "625", currency: "USD" },
      { key },
    );
    expect(first.statusCode).toBe(201);
    expect(first.body).toBe('{"amount":"1250","currency":"USD"}');
    expect(first.headers).not.toHaveProperty(REPLAYED_HEADER);
    const replay = await post(
      "money",
      { amount: "625", currency: "USD" },
      { key },
    );
    expect(replay.statusCode).toBe(201);
    expect(replay.body).toBe(first.body);
    expect(replay.headers[REPLAYED_HEADER]).toBe("true");
    expect(replay.headers["content-type"]).toBe(first.headers["content-type"]);
    const rows = await keyRows(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.response).toBe(first.body);
    expect(await probeRows("money-USD")).toHaveLength(1);
    // The body is validated by the DTO: a bad amount is 422, nothing written.
    const bad = await post(
      "money",
      { amount: "6.25", currency: "USD" },
      { key: nextKey() },
    );
    expectProblem(bad, 422, "validation_failed");
    expect(ErrorEnvelopeSchema.parse(JSON.parse(bad.body)).issues).toEqual([
      {
        path: ["amount"],
        code: "money.invalid_amount",
        key: "errors:money.invalid_amount",
      },
    ]);
    expect(fromMinor(1250n, "USD").amount).toBe(1250n);
  });

  test("an @Idempotent() route returning a bigint without a response DTO is 500 generic: nothing stored, no key", async () => {
    const key = nextKey();
    const res = await post("bigint", { name: "bigint-1" }, { key });
    expectProblem(res, 500, "generic");
    expect(await keyRows(key)).toHaveLength(0);
    expect(await probeRows("bigint-1")).toHaveLength(0);
  });

  test("a 200 route replays its ETag; a header outside the allow-list is not replayed", async () => {
    const key = nextKey();
    const name = `tagged-${key}`;
    const first = await post("tagged", { name }, { key });
    expect(first.statusCode).toBe(200);
    expect(first.headers.etag).toMatch(/^"[0-9a-f-]{36}"$/);
    expect(first.headers["x-not-replayed"]).toBe("first-only");
    const replay = await post("tagged", { name }, { key });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toBe(first.body);
    expect(replay.headers.etag).toBe(first.headers.etag);
    expect(replay.headers).not.toHaveProperty("x-not-replayed");
    expect(replay.headers[REPLAYED_HEADER]).toBe("true");
    const rows = await keyRows(key);
    expect(rows[0]?.headers).toEqual({
      "content-type": "application/json; charset=utf-8",
      etag: first.headers.etag,
    });
    expect(await probeRows(name)).toHaveLength(1);
  });
});
