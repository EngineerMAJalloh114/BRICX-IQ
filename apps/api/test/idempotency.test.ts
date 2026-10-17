// P4-07 (ADR 0057, decision 6a): the idempotency layer without a
// database. The fingerprint is SHA-256 over RFC 8785 canonical JSON of
// { body, query } (an independent literal-string oracle); the header is
// checked before any database access; a route without @Idempotent()
// ignores the header; a handler on an @Idempotent() route that never
// opens TxRunner.run() is a server error, not a silent non-idempotent
// write.
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { loadApiConfig } from "@bricx/config/api";
import type { Database } from "@bricx/db/database";
import { IDEMPOTENCY_KEY_PATTERN } from "@bricx/db/idempotency";
import { ErrorEnvelopeSchema } from "@bricx/validation/error-envelope";
import {
  Body,
  type CanActivate,
  Controller,
  type ExecutionContext,
  Inject,
  Injectable,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { setIdentity } from "../src/common/db/request-context.js";
import { TxRunner } from "../src/common/db/tx-runner.js";
import {
  IDEMPOTENCY_KEY_HEADER,
  Idempotent,
  REPLAYED_HEADER,
} from "../src/common/idempotency/decorator.js";
import {
  idempotencyRoute,
  requestFingerprint,
} from "../src/common/idempotency/fingerprint.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";

const ORG = "0199e1a0-0000-7000-8000-00000000000a";
const USER = "0199e1a0-0000-7000-8000-000000000001";
const SECRET = "body-marker-never-in-an-error-4d1c";

describe("requestFingerprint({ query, body })", () => {
  test("is SHA-256 over RFC 8785 canonical JSON: sorted keys, no whitespace, body before query (literal oracle)", () => {
    const digest = requestFingerprint({
      query: { b: "2", a: "1" },
      body: { z: 1, a: [1, 2, { y: true, x: null }], s: "é\u0000" },
    });
    const oracle = createHash("sha256")
      .update(
        '{"body":{"a":[1,2,{"x":null,"y":true}],"s":"é\\u0000","z":1},"query":{"a":"1","b":"2"}}',
        "utf8",
      )
      .digest();
    expect(Buffer.isBuffer(digest)).toBe(true);
    expect(digest).toHaveLength(32);
    expect(digest.equals(oracle)).toBe(true);
  });

  test("key order never matters; a moved value, a changed query or a body-vs-query swap does", () => {
    const a = requestFingerprint({ query: {}, body: { x: 1, y: 2 } });
    expect(
      a.equals(requestFingerprint({ query: {}, body: { y: 2, x: 1 } })),
    ).toBe(true);
    expect(
      a.equals(requestFingerprint({ query: {}, body: { x: 2, y: 1 } })),
    ).toBe(false);
    expect(
      a.equals(requestFingerprint({ query: { q: "1" }, body: { x: 1, y: 2 } })),
    ).toBe(false);
    expect(
      requestFingerprint({ query: { x: "1" }, body: {} }).equals(
        requestFingerprint({ query: {}, body: { x: "1" } }),
      ),
    ).toBe(false);
  });

  test("no body and an empty body hash differently; the oracle for no body is null", () => {
    const none = requestFingerprint({ query: {}, body: undefined });
    const oracle = createHash("sha256")
      .update('{"body":null,"query":{}}', "utf8")
      .digest();
    expect(none.equals(oracle)).toBe(true);
    expect(none.equals(requestFingerprint({ query: {}, body: {} }))).toBe(
      false,
    );
  });

  test("idempotencyRoute(): METHOD and the path without its query string", () => {
    expect(idempotencyRoute("POST", "/v1/things?page=2&k=v")).toBe(
      "POST /v1/things",
    );
    expect(idempotencyRoute("post", "/v1/things/0199e1a0")).toBe(
      "POST /v1/things/0199e1a0",
    );
    expect(idempotencyRoute("PATCH", "/v1/a#frag")).toBe("PATCH /v1/a");
  });
});

/** Stands in for P5's auth guard: the identity from test headers. */
@Injectable()
class TestIdentityGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const headers = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>().headers;
    if (headers["x-test-org"] !== undefined) {
      setIdentity({
        orgId: headers["x-test-org"],
        userId: USER,
        projectIds: [],
        roles: [],
      });
    }
    return true;
  }
}

@Controller({ path: "idem", version: "1" })
@UseGuards(TestIdentityGuard)
class IdemController {
  constructor(@Inject(TxRunner) private readonly runner: TxRunner) {}

  @Post("things")
  @Idempotent()
  create(@Body() body: unknown) {
    return this.runner.run(() => Promise.resolve({ echo: body }));
  }

  @Post("none")
  @Idempotent()
  none(@Body() body: unknown) {
    // Never opens a transaction: the layer has nothing to store.
    return { echo: body };
  }

  @Post("plain")
  plain(@Body() body: unknown) {
    return { echo: body };
  }
}

const config = loadApiConfig(apiEnv());

let dbCalls = 0;
/** A request pool that counts every access and never answers. */
const noDatabase: Database = {
  ping: () => Promise.reject(new Error("no database in idempotency.test")),
  withTx: () => {
    dbCalls += 1;
    return Promise.reject(new Error("no database in idempotency.test"));
  },
  close: () => Promise.resolve(),
};

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start() {
  const lines: string[] = [];
  app = await createApp(config, {
    probes: fakeProbes(),
    database: noDatabase,
    logStream: new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
        done();
      },
    }),
    extraControllers: [IdemController],
    extraProviders: [TestIdentityGuard],
  });
  await app.init();
  dbCalls = 0;
  const logs = () =>
    lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { app, logs };
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

describe("the Idempotency-Key header (decision 6a)", () => {
  test("the header names and the key bound are the shared ones", () => {
    expect(IDEMPOTENCY_KEY_HEADER).toBe("idempotency-key");
    expect(REPLAYED_HEADER).toBe("idempotent-replayed");
    expect(IDEMPOTENCY_KEY_PATTERN.test("k".repeat(255))).toBe(true);
  });

  test("missing on an @Idempotent() route: 400 idempotency.key_missing before any database access", async () => {
    const { app, logs } = await start();
    const res = await app.inject({
      method: "POST",
      url: "/v1/idem/things",
      headers: { "x-test-org": ORG, "content-type": "application/json" },
      payload: { secret: SECRET },
    });
    expectProblem(res, 400, "idempotency.key_missing");
    expect(dbCalls).toBe(0);
    expect(logs().filter((l) => l.msg === "request.rejected")).toHaveLength(1);
  });

  test.each([
    ["empty", ""],
    ["a space", "a b"],
    ["256 characters", "k".repeat(256)],
    ["a slash", "a/b"],
    ["non-ASCII", "clé"],
  ])(
    "invalid (%s): 400 idempotency.key_invalid before any database access",
    async (_label, key) => {
      const { app } = await start();
      const res = await app.inject({
        method: "POST",
        url: "/v1/idem/things",
        headers: {
          "x-test-org": ORG,
          "content-type": "application/json",
          [IDEMPOTENCY_KEY_HEADER]: key,
        },
        payload: { secret: SECRET },
      });
      expectProblem(res, 400, "idempotency.key_invalid");
      expect(dbCalls).toBe(0);
    },
  );

  test("two Idempotency-Key headers are one invalid key", async () => {
    const { app } = await start();
    const res = await app.inject({
      method: "POST",
      url: "/v1/idem/things",
      headers: {
        "x-test-org": ORG,
        "content-type": "application/json",
        [IDEMPOTENCY_KEY_HEADER]: ["k1", "k2"],
      },
      payload: {},
    });
    expectProblem(res, 400, "idempotency.key_invalid");
    expect(dbCalls).toBe(0);
  });

  test("a body that is not JSON on an @Idempotent() route is 415 (owner condition 6), before any database access", async () => {
    const { app } = await start();
    const res = await app.inject({
      method: "POST",
      url: "/v1/idem/things",
      headers: {
        "x-test-org": ORG,
        "content-type": "text/plain",
        [IDEMPOTENCY_KEY_HEADER]: "k1",
      },
      payload: SECRET,
    });
    expectProblem(res, 415, "request.unsupported_media_type");
    expect(dbCalls).toBe(0);
  });

  test("without an identity: 401 session_expired (pre-P5, owner condition 6), before any database access", async () => {
    const { app } = await start();
    const res = await app.inject({
      method: "POST",
      url: "/v1/idem/things",
      headers: {
        "content-type": "application/json",
        [IDEMPOTENCY_KEY_HEADER]: "k1",
      },
      payload: {},
    });
    expectProblem(res, 401, "session_expired");
    expect(dbCalls).toBe(0);
  });

  test("a valid key reaches the database once (the claim is the transaction's first statement)", async () => {
    const { app } = await start();
    const res = await app.inject({
      method: "POST",
      url: "/v1/idem/things",
      headers: {
        "x-test-org": ORG,
        "content-type": "application/json",
        [IDEMPOTENCY_KEY_HEADER]: "k1",
      },
      payload: {},
    });
    expectProblem(res, 500, "generic");
    expect(dbCalls).toBe(1);
  });

  test("a route without @Idempotent() ignores the header, valid or not", async () => {
    const { app } = await start();
    for (const key of ["k1", "a b", ""]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/idem/plain",
        headers: {
          "x-test-org": ORG,
          "content-type": "application/json",
          [IDEMPOTENCY_KEY_HEADER]: key,
        },
        payload: { n: key },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ echo: { n: key } });
      expect(res.headers).not.toHaveProperty(REPLAYED_HEADER);
    }
    expect(dbCalls).toBe(0);
  });

  test("an @Idempotent() handler that never opens TxRunner.run() is 500 generic, logged as IdempotencyMisuseError", async () => {
    const { app, logs } = await start();
    const res = await app.inject({
      method: "POST",
      url: "/v1/idem/none",
      headers: {
        "x-test-org": ORG,
        "content-type": "application/json",
        [IDEMPOTENCY_KEY_HEADER]: "k1",
      },
      payload: { secret: SECRET },
    });
    expectProblem(res, 500, "generic");
    const failed = logs().filter((l) => l.msg === "request.failed");
    expect(failed).toHaveLength(1);
    expect((failed[0]?.err as { type?: string; message?: string }).type).toBe(
      "IdempotencyMisuseError",
    );
    expect((failed[0]?.err as { message?: string }).message).toBe(
      "idempotency misuse: no_run",
    );
    expect(dbCalls).toBe(0);
  });
});
