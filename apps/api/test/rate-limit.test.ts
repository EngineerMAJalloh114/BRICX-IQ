// Rate limiting and abuse controls (P6-05d, ADR 0080; owner conditions
// C1, C2, C7 and C8), without Valkey: the in-process store (the guard's
// own fallback) or a store that is always down. The Valkey store, its
// Lua script and the shared client are proved live in
// rate-limit.int.test.ts.
// - Keys are rl:v1:<class>:<dim>:<id>; the id is a user or org UUID, or
//   the first 32 hex of SHA-256 of the client address (IPv6 by /64):
//   never a token, a sid, an e-mail or an address.
// - Per request: the IP stage before the AuthGuard (a flood of bad
//   tokens is counted before any verification), the user and org stage
//   after it and before the authorization guard.
// - C1: the class's ip limit applies only to @Public routes; every other
//   route is counted once, against the default class's loose ip limit
//   (6000 per 60 s), so a site of 200 workers behind one NAT is never
//   throttled by its address.
// - Over a limit: 429 rate_limited (the existing code, C8) as
//   problem+json with Retry-After (whole seconds, at least 1); the body is
//   the standard envelope, nothing about buckets, classes or limits.
// - Store down: default routes, and routes marked storeDown "fallback"
//   (C2: GET /v1/directory/resolve), fall back to the in-process store at
//   the same limits; the other classes fail closed with 503
//   server_unavailable (the existing code, C8) and Retry-After 5. One
//   rate_limit.store_unavailable warn line per class and mode at most
//   every 10 s, with no address, id or key.
// - The health probes are never limited; the OpenAPI document lists 429
//   on every other operation.
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { loadApiConfig } from "@bricx/config/api";
import { RATE_LIMIT_DEFAULTS } from "@bricx/config/rate-limits";
import type { CellRoute, DirectoryReader } from "@bricx/db/directory";
import { ErrorEnvelopeSchema } from "@bricx/validation/error-envelope";
import { Controller, Get, HttpCode, Post } from "@nestjs/common";
import type { ThrottlerStorage } from "@nestjs/throttler";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { NoPermission } from "../src/common/auth/can.decorator.js";
import { Public } from "../src/common/auth/public.decorator.js";
import type { Clock } from "../src/common/clock.js";
import {
  RATE_LIMIT_KEY_PREFIX,
  ipKeyId,
  rateLimitKey,
} from "../src/common/rate-limit/keys.js";
import {
  STORE_DOWN_DEFAULTS,
  STORE_DOWN_LOG_INTERVAL_MS,
  STORE_DOWN_RETRY_AFTER_SECONDS,
  retryAfterSeconds,
} from "../src/common/rate-limit/policy.js";
import {
  RateLimit,
  RateLimitExempt,
} from "../src/common/rate-limit/rate-limit.decorator.js";
import { rateLimitRoutes } from "../src/common/rate-limit/routes.js";
import {
  FALLBACK_MAX_KEYS,
  MemoryRateLimitStore,
} from "../src/common/rate-limit/store.js";
import { apiEnv, exampleValue } from "./env.js";
import { fakeProbes } from "./probes.js";
import {
  TestIssuer,
  bearer,
  fixedRevocations,
  fixedSessions,
  fixedUsers,
  roleGrants,
  sidFor,
} from "./support/auth.js";
import { failingRateLimits, memoryRateLimits } from "./support/rate-limit.js";

const ORG_A = "0199e1a0-0000-7000-8000-0000000000a1";
const ORG_B = "0199e1a0-0000-7000-8000-0000000000b1";
const USER_FALLBACK = "0199e1a0-0000-7000-8000-0000000000ff";
const SUB_SENTINEL = "sub-sentinel-rl-4b1e-personal";
/** A user id per test sub: user-<n>. */
const userOf = (n: number) =>
  `0199e1a0-0000-7000-8000-${(0x100 + n).toString(16).padStart(12, "0")}`;
const subOf = (n: number) => `rl-user-${String(n)}`;
const USERS: Record<string, string> = {
  [SUB_SENTINEL]: USER_FALLBACK,
  ...Object.fromEntries(
    Array.from({ length: 220 }, (_, n) => [subOf(n), userOf(n)]),
  ),
};

@NoPermission("test-only probe")
@Controller({ path: "rl", version: "1" })
class ProbeController {
  @Get("default")
  plain() {
    return { ok: true };
  }

  @Post("auth-adjacent")
  @HttpCode(200)
  @RateLimit("auth_adjacent")
  authAdjacent() {
    return { ok: true };
  }

  @Post("invitation")
  @HttpCode(200)
  @RateLimit("invitation")
  invitation() {
    return { ok: true };
  }

  @Post("upload")
  @HttpCode(200)
  @RateLimit("upload")
  upload() {
    return { ok: true };
  }

  @Post("export")
  @HttpCode(200)
  @RateLimit("export")
  export() {
    return { ok: true };
  }
}

@Controller({ path: "rl-public", version: "1" })
@Public()
class PublicProbeController {
  @Get("default")
  plain() {
    return { ok: true };
  }

  @Get("auth-adjacent")
  @RateLimit("auth_adjacent")
  authAdjacent() {
    return { ok: true };
  }

  @Get("auth-adjacent-fallback")
  @RateLimit("auth_adjacent", { storeDown: "fallback" })
  authAdjacentFallback() {
    return { ok: true };
  }

  @Get("exempt")
  @RateLimitExempt()
  exempt() {
    return { ok: true };
  }
}

const ACME: CellRoute = {
  cell: "af-south-1",
  apiBaseUrl: "https://api.af-south-1.bricx.invalid",
  keycloakUrl: "https://id.af-south-1.bricx.invalid/realms/bricx",
};
const reader: DirectoryReader = {
  ping: () => Promise.resolve(),
  resolve: () => Promise.resolve(ACME),
  close: () => Promise.resolve(),
};

let issuer: TestIssuer;
beforeAll(async () => {
  issuer = await TestIssuer.start();
});
afterAll(async () => {
  await issuer.close();
});

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface Started {
  readonly app: NestFastifyApplication;
  readonly lines: string[];
  readonly logged: () => Record<string, unknown>[];
}

interface StartOptions {
  readonly env?: Record<string, string>;
  readonly store?: ThrottlerStorage;
  readonly clock?: Clock;
}

async function start(options: StartOptions = {}): Promise<Started> {
  const lines: string[] = [];
  const logStream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
      done();
    },
  });
  app = await createApp(
    loadApiConfig(
      apiEnv({
        ...issuer.env(),
        DIRECTORY_DATABASE_URL: exampleValue("DIRECTORY_DATABASE_URL"),
        ...options.env,
      }),
    ),
    {
      probes: fakeProbes(),
      logStream,
      extraControllers: [ProbeController, PublicProbeController],
      userDirectory: fixedUsers(USERS, USER_FALLBACK),
      sessionTracker: fixedSessions(),
      revocationStore: fixedRevocations(),
      grantsSource: roleGrants(),
      directoryReader: reader,
      rateLimitStore: options.store ?? memoryRateLimits(options.clock),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    },
  );
  await app.init();
  const started = app;
  return {
    app: started,
    lines,
    logged: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

type Res = Awaited<ReturnType<NestFastifyApplication["inject"]>>;

interface Call {
  readonly method?: "GET" | "POST";
  readonly url: string;
  readonly user?: number;
  readonly org?: string;
  readonly token?: string;
  readonly headers?: Record<string, string>;
  readonly remoteAddress?: string;
}

async function call(s: Started, c: Call): Promise<Res> {
  const token =
    c.token ??
    (c.user === undefined
      ? undefined
      : await issuer.token({ sub: subOf(c.user), org_id: c.org ?? ORG_A }));
  return s.app.inject({
    method: c.method ?? "GET",
    url: c.url,
    headers: {
      ...(token === undefined ? {} : bearer(token)),
      ...c.headers,
    },
    ...(c.remoteAddress === undefined
      ? {}
      : { remoteAddress: c.remoteAddress }),
  });
}

function expectRateLimited(res: Res): void {
  expect(res.statusCode, res.body).toBe(429);
  expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  const retryAfter = Number(res.headers["retry-after"]);
  expect(Number.isInteger(retryAfter)).toBe(true);
  expect(retryAfter).toBeGreaterThanOrEqual(1);
  const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(res.body));
  expect(parsed.success).toBe(true);
  expect(parsed.data).toMatchObject({
    status: 429,
    code: "rate_limited",
    key: "errors:rate_limited",
  });
  expect(Object.keys(JSON.parse(res.body) as object).sort()).toEqual(
    ["code", "key", "status", "traceId"].sort(),
  );
  for (const word of ["rl:v1", "bucket", "class", "window", "org"]) {
    expect(res.body.toLowerCase()).not.toContain(word);
  }
  expect(res.headers).not.toHaveProperty("x-ratelimit-limit");
  expect(res.headers).not.toHaveProperty("x-ratelimit-remaining");
}

/** Statuses of `n` sequential calls. */
async function statuses(s: Started, n: number, c: Call): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) out.push((await call(s, c)).statusCode);
  return out;
}

describe("keys", () => {
  test("rl:v1:<class>:<dim>:<id>", () => {
    expect(RATE_LIMIT_KEY_PREFIX).toBe("rl:v1:");
    expect(rateLimitKey("default", "user", userOf(1))).toBe(
      `rl:v1:default:user:${userOf(1)}`,
    );
    expect(rateLimitKey("auth_adjacent", "org", ORG_A)).toBe(
      `rl:v1:auth_adjacent:org:${ORG_A}`,
    );
  });

  test("an address is 32 hex of SHA-256, never the address; IPv6 by /64", () => {
    const id = ipKeyId("203.0.113.9");
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).toBe(
      createHash("sha256").update("203.0.113.9").digest("hex").slice(0, 32),
    );
    expect(ipKeyId("203.0.113.10")).not.toBe(id);
    expect(rateLimitKey("default", "ip", id)).not.toContain("203.0.113");
    expect(ipKeyId("2001:db8:1:2::1")).toBe(ipKeyId("2001:db8:1:2:ffff::9"));
    expect(ipKeyId("2001:db8:1:2::1")).not.toBe(ipKeyId("2001:db8:1:3::1"));
  });
});

describe("Retry-After", () => {
  test.each([
    [0, 1],
    [0.2, 1],
    [1, 1],
    [1.01, 2],
    [59.5, 60],
    [600, 600],
  ])("%d s left is %d", (left, header) => {
    expect(retryAfterSeconds(left)).toBe(header);
  });

  test("the store-down answer says 5 s", () => {
    expect(STORE_DOWN_RETRY_AFTER_SECONDS).toBe(5);
  });
});

describe("the in-process store", () => {
  test("counts per key inside the window and starts again after it", async () => {
    let now = 1_000_000;
    const store = new MemoryRateLimitStore({ now: () => now });
    const hit = () => store.increment("k", 2_000, 2);
    expect(await hit()).toMatchObject({ totalHits: 1, isBlocked: false });
    expect(await hit()).toMatchObject({ totalHits: 2, isBlocked: false });
    const third = await hit();
    expect(third).toMatchObject({ totalHits: 3, isBlocked: true });
    expect(third.timeToExpire).toBe(2);
    now += 1_500;
    expect((await hit()).timeToExpire).toBe(1);
    now += 600;
    expect(await hit()).toMatchObject({ totalHits: 1, isBlocked: false });
  });

  test("holds at most 10,000 keys, the least recently used dropped first", async () => {
    expect(FALLBACK_MAX_KEYS).toBe(10_000);
    const store = new MemoryRateLimitStore({ now: () => 0 });
    await store.increment("keep", 60_000, 5);
    for (let i = 0; i < FALLBACK_MAX_KEYS + 50; i += 1) {
      await store.increment(`k${String(i)}`, 60_000, 5);
      if (i % 1_000 === 0) {
        await store.increment("keep", 60_000, 5);
      }
    }
    expect(store.size).toBeLessThanOrEqual(FALLBACK_MAX_KEYS);
    expect((await store.increment("k0", 60_000, 5)).totalHits).toBe(1);
    expect(
      (await store.increment("keep", 60_000, 5)).totalHits,
    ).toBeGreaterThan(1);
  });
});

describe("route classes", () => {
  test("the app's routes are classed as approved (directory resolve falls back, C2)", async () => {
    const s = await start();
    const table = new Map(
      rateLimitRoutes(s.app).map((r) => [
        r.route,
        r.exempt ? "exempt" : `${r.cls}/${r.storeDown}`,
      ]),
    );
    expect(
      Object.fromEntries(
        [
          "POST /organizations",
          "GET /directory/resolve",
          "POST /devices",
          "POST /users/:userId/sessions/revoke",
          "DELETE /sessions/:id",
          "POST /access-grants",
          "POST /members",
          "POST /projects/:projectId/members",
          // P6-06 (ADR 0077, D16): every invitation route.
          "POST /invitations",
          "GET /invitations",
          "GET /invitations/:id",
          "POST /invitations/:id/resend",
          "DELETE /invitations/:id",
          "POST /invitations/activate",
          "POST /invitations/accept",
          "GET /health/live",
          "GET /health/ready",
          "GET /projects",
          "GET /devices",
          "PATCH /organizations/current",
          "GET /openapi.json",
        ].map((route) => [route, table.get(route)]),
      ),
    ).toEqual({
      "POST /organizations": "auth_adjacent/closed",
      "GET /directory/resolve": "auth_adjacent/fallback",
      "POST /devices": "auth_adjacent/closed",
      "POST /users/:userId/sessions/revoke": "auth_adjacent/closed",
      "DELETE /sessions/:id": "auth_adjacent/closed",
      "POST /access-grants": "auth_adjacent/closed",
      "POST /members": "invitation/closed",
      "POST /projects/:projectId/members": "invitation/closed",
      "POST /invitations": "invitation/closed",
      "GET /invitations": "invitation/closed",
      "GET /invitations/:id": "invitation/closed",
      "POST /invitations/:id/resend": "invitation/closed",
      "DELETE /invitations/:id": "invitation/closed",
      "POST /invitations/activate": "invitation/closed",
      "POST /invitations/accept": "invitation/closed",
      "GET /health/live": "exempt",
      "GET /health/ready": "exempt",
      "GET /projects": "default/fallback",
      "GET /devices": "default/fallback",
      "PATCH /organizations/current": "default/fallback",
      "GET /openapi.json": "default/fallback",
    });
    expect(STORE_DOWN_DEFAULTS).toEqual({
      default: "fallback",
      auth_adjacent: "closed",
      invitation: "closed",
      upload: "closed",
      export: "closed",
    });
  });

  test("a route with an unknown class stops the app from starting", async () => {
    @NoPermission("test-only probe")
    @Controller({ path: "rl-bad", version: "1" })
    class BadController {
      @Get()
      @RateLimit("bogus" as never)
      bad() {
        return { ok: true };
      }
    }
    await expect(
      createApp(loadApiConfig(apiEnv(issuer.env())), {
        probes: fakeProbes(),
        extraControllers: [BadController],
        revocationStore: fixedRevocations(),
        rateLimitStore: memoryRateLimits(),
      }),
    ).rejects.toThrow(/rate limit class: BadController\.bad/);
  });
});

describe("over a limit (C8: 429 rate_limited)", () => {
  test("a user over the user limit gets 429 with Retry-After; another user of the org does not", async () => {
    const s = await start({
      env: { RATE_LIMIT_DEFAULT: "ip=1000,user=2,org=1000,window=60" },
    });
    const one = { url: "/v1/rl/default", user: 1 };
    expect(await statuses(s, 2, one)).toEqual([200, 200]);
    const refused = await call(s, one);
    expectRateLimited(refused);
    expect(Number(refused.headers["retry-after"])).toBeLessThanOrEqual(60);
    expect((await call(s, { url: "/v1/rl/default", user: 2 })).statusCode).toBe(
      200,
    );
  });

  test("an org over the org limit gets 429; another org does not (S1)", async () => {
    const s = await start({
      env: { RATE_LIMIT_DEFAULT: "ip=1000,user=1000,org=3,window=60" },
    });
    for (const user of [1, 2, 3]) {
      expect((await call(s, { url: "/v1/rl/default", user })).statusCode).toBe(
        200,
      );
    }
    expectRateLimited(await call(s, { url: "/v1/rl/default", user: 4 }));
    expect(
      (await call(s, { url: "/v1/rl/default", user: 5, org: ORG_B }))
        .statusCode,
    ).toBe(200);
  });

  test("Retry-After is the whole seconds left of the window (S3)", async () => {
    let offset = 0;
    const clock = { now: () => Date.now() + offset };
    const s = await start({
      env: { RATE_LIMIT_DEFAULT: "ip=1000,user=1,org=1000,window=60" },
      clock,
    });
    const one = { url: "/v1/rl/default", user: 1 };
    expect((await call(s, one)).statusCode).toBe(200);
    offset = 20_500;
    const refused = await call(s, one);
    expectRateLimited(refused);
    expect(Number(refused.headers["retry-after"])).toBe(40);
  });
});

describe("C1: the ip limit and the NAT", () => {
  test("(a) 200 authenticated users behind one address, each within their own limits, are never throttled (S7)", async () => {
    const s = await start();
    const results: number[] = [];
    for (let n = 0; n < 200; n += 1) {
      results.push(
        (
          await call(s, {
            method: "POST",
            url: "/v1/rl/auth-adjacent",
            user: n,
          })
        ).statusCode,
      );
      results.push(
        (await call(s, { url: "/v1/rl/default", user: n })).statusCode,
      );
      results.push(
        (await call(s, { url: "/v1/rl/default", user: n })).statusCode,
      );
    }
    expect(results.filter((status) => status !== 200)).toEqual([]);
    // More than the class ip limit came from one address.
    expect(RATE_LIMIT_DEFAULTS.auth_adjacent.ip).toBeLessThan(200);
  });

  test("(c) a @Public route is limited by its class's ip limit", async () => {
    const s = await start();
    const limit = RATE_LIMIT_DEFAULTS.auth_adjacent.ip;
    expect(
      new Set(await statuses(s, limit, { url: "/v1/rl-public/auth-adjacent" })),
    ).toEqual(new Set([200]));
    expectRateLimited(await call(s, { url: "/v1/rl-public/auth-adjacent" }));
    // Another address has its own bucket.
    expect(
      (
        await call(s, {
          url: "/v1/rl-public/auth-adjacent",
          remoteAddress: "203.0.113.77",
        })
      ).statusCode,
    ).toBe(200);
  });

  test("every authenticated route counts once against the default class's loose ip limit", async () => {
    const s = await start({
      env: { RATE_LIMIT_DEFAULT: "ip=3,user=1000,org=1000,window=60" },
    });
    expect(
      await statuses(s, 3, {
        method: "POST",
        url: "/v1/rl/auth-adjacent",
        user: 1,
      }),
    ).toEqual([200, 200, 200]);
    expectRateLimited(await call(s, { url: "/v1/rl/default", user: 2 }));
  });
});

describe("the order: the IP stage runs before the AuthGuard (S5)", () => {
  test("bad tokens from one address: 401 until the ip limit, then 429", async () => {
    const s = await start({
      env: { RATE_LIMIT_DEFAULT: "ip=2,user=1000,org=1000,window=60" },
    });
    const bad = { url: "/v1/rl/default", token: "not-a-token" };
    expect(await statuses(s, 2, bad)).toEqual([401, 401]);
    expectRateLimited(await call(s, bad));
  });
});

describe("TRUST_PROXY (S2)", () => {
  const spoof = (n: number) => ({
    "x-forwarded-for": `198.51.100.${String(n)}`,
  });
  const env = (trust?: string) => ({
    RATE_LIMIT_AUTH_ADJACENT: "ip=2,user=1000,org=1000,window=60",
    ...(trust === undefined ? {} : { TRUST_PROXY: trust }),
  });

  test("off: a spoofed X-Forwarded-For does not change the bucket", async () => {
    const s = await start({ env: env() });
    const got: number[] = [];
    for (let n = 1; n <= 3; n += 1) {
      got.push(
        (
          await call(s, {
            url: "/v1/rl-public/auth-adjacent",
            headers: spoof(n),
          })
        ).statusCode,
      );
    }
    expect(got).toEqual([200, 200, 429]);
  });

  test("a CIDR list: honoured from a trusted peer, ignored from any other", async () => {
    const s = await start({ env: env("127.0.0.1/32") });
    for (let n = 1; n <= 5; n += 1) {
      expect(
        (
          await call(s, {
            url: "/v1/rl-public/auth-adjacent",
            headers: spoof(n),
          })
        ).statusCode,
      ).toBe(200);
    }
    const untrusted: number[] = [];
    for (let n = 1; n <= 3; n += 1) {
      untrusted.push(
        (
          await call(s, {
            url: "/v1/rl-public/auth-adjacent",
            headers: spoof(n),
            remoteAddress: "203.0.113.9",
          })
        ).statusCode,
      );
    }
    expect(untrusted).toEqual([200, 200, 429]);
  });

  test("hops:1: the address the trusted hop saw", async () => {
    const s = await start({ env: env("hops:1") });
    const same = { url: "/v1/rl-public/auth-adjacent", headers: spoof(9) };
    expect(await statuses(s, 3, same)).toEqual([200, 200, 429]);
    expect(
      (
        await call(s, {
          url: "/v1/rl-public/auth-adjacent",
          headers: spoof(10),
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe("store down (C2, S4)", () => {
  test("default routes fall back to the in-process store, at the same limits", async () => {
    const store = failingRateLimits();
    const s = await start({
      store,
      env: { RATE_LIMIT_DEFAULT: "ip=1000,user=2,org=1000,window=60" },
    });
    const one = { url: "/v1/rl/default", user: 1 };
    expect(await statuses(s, 2, one)).toEqual([200, 200]);
    expectRateLimited(await call(s, one));
    expect(store.calls).toBeGreaterThan(0);
  });

  test.each([
    ["/v1/rl/auth-adjacent", "auth_adjacent"],
    ["/v1/rl/invitation", "invitation"],
    ["/v1/rl/upload", "upload"],
    ["/v1/rl/export", "export"],
  ])(
    "%s fails closed: 503 server_unavailable with Retry-After 5",
    async (url) => {
      const s = await start({ store: failingRateLimits() });
      const res = await call(s, { method: "POST", url, user: 1 });
      expect(res.statusCode, res.body).toBe(503);
      expect(res.headers["retry-after"]).toBe("5");
      expect(res.headers["content-type"]).toMatch(
        /^application\/problem\+json/,
      );
      expect(JSON.parse(res.body)).toMatchObject({
        status: 503,
        code: "server_unavailable",
      });
    },
  );

  test("a @Public auth_adjacent route fails closed; one marked fallback is limited in-process at its class's limits", async () => {
    const s = await start({ store: failingRateLimits() });
    expect(
      (await call(s, { url: "/v1/rl-public/auth-adjacent" })).statusCode,
    ).toBe(503);
    const limit = RATE_LIMIT_DEFAULTS.auth_adjacent.ip;
    expect(
      new Set(
        await statuses(s, limit, {
          url: "/v1/rl-public/auth-adjacent-fallback",
        }),
      ),
    ).toEqual(new Set([200]));
    expectRateLimited(
      await call(s, { url: "/v1/rl-public/auth-adjacent-fallback" }),
    );
  });

  test("C2: GET /v1/directory/resolve keeps answering, limited in-process at the auth_adjacent limits", async () => {
    const s = await start({ store: failingRateLimits() });
    const url = "/v1/directory/resolve?org_slug=acme";
    const limit = RATE_LIMIT_DEFAULTS.auth_adjacent.ip;
    expect(new Set(await statuses(s, limit, { url }))).toEqual(new Set([200]));
    expectRateLimited(await call(s, { url }));
  });

  test("one rate_limit.store_unavailable warn line per class and mode every 10 s, with no address, id or key", async () => {
    let offset = 0;
    const clock = { now: () => Date.now() + offset };
    const s = await start({ store: failingRateLimits(), clock });
    for (let i = 0; i < 5; i += 1) {
      await call(s, { url: "/v1/rl/default", user: 1 });
      await call(s, { method: "POST", url: "/v1/rl/auth-adjacent", user: 1 });
    }
    const warnings = () =>
      s.logged().filter((l) => l.msg === "rate_limit.store_unavailable");
    expect(
      warnings()
        .map((l) => `${String(l.class)}/${String(l.mode)}`)
        .sort(),
    ).toEqual(["auth_adjacent/fail_closed", "default/fail_open"]);
    for (const line of warnings()) {
      expect(line.level).toBe(40);
      const text = JSON.stringify(line);
      for (const secret of [userOf(1), ORG_A, "127.0.0.1", "rl:v1", subOf(1)]) {
        expect(text).not.toContain(secret);
      }
    }
    expect(STORE_DOWN_LOG_INTERVAL_MS).toBe(10_000);
    offset = STORE_DOWN_LOG_INTERVAL_MS + 1_000;
    await call(s, { url: "/v1/rl/default", user: 1 });
    expect(warnings()).toHaveLength(3);
  });
});

describe("health, logs and the document", () => {
  test("/health/live and /health/ready are never limited", async () => {
    const s = await start({
      env: { RATE_LIMIT_DEFAULT: "ip=1,user=1,org=1,window=60" },
    });
    for (const url of ["/health/live", "/health/ready"]) {
      expect(new Set(await statuses(s, 5, { url }))).toEqual(new Set([200]));
    }
    expect(
      new Set(await statuses(s, 5, { url: "/v1/rl-public/exempt" })),
    ).toEqual(new Set([200]));
  });

  test("no token, sid, sub, forwarded header or key in any log line, no address or id in a rate-limit line; a 429 logs its class and dimension", async () => {
    const s = await start({
      env: {
        RATE_LIMIT_DEFAULT: "ip=1000,user=1,org=1000,window=60",
        TRUST_PROXY: "127.0.0.1/32",
      },
    });
    const token = await issuer.token({ sub: SUB_SENTINEL, org_id: ORG_A });
    const headers = { "x-forwarded-for": "192.0.2.201" };
    await call(s, { url: "/v1/rl/default", token, headers });
    expectRateLimited(await call(s, { url: "/v1/rl/default", token, headers }));
    const all = s.lines.join("\n");
    for (const secret of [
      token,
      SUB_SENTINEL,
      sidFor(SUB_SENTINEL),
      ipKeyId("192.0.2.201"),
      "rl:v1",
      "x-forwarded-for",
    ]) {
      expect(all).not.toContain(secret);
    }
    const exceeded = s.logged().filter((l) => l.msg === "rate_limit.exceeded");
    expect(exceeded).toHaveLength(1);
    expect(exceeded[0]).toMatchObject({ class: "default", dim: "user" });
    // The request line carries the client address (ADR 0080); the
    // rate-limit lines carry no address and no id.
    for (const line of s.lines.filter((l) => l.includes("rate_limit."))) {
      for (const secret of ["192.0.2.201", "127.0.0.1", USER_FALLBACK, ORG_A]) {
        expect(line).not.toContain(secret);
      }
    }
  });

  test("the OpenAPI document lists 429 with Retry-After on every operation but the exempt ones (the health probes)", async () => {
    const s = await start();
    const res = await call(s, { url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    const doc = JSON.parse(res.body) as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, unknown> }>
      >;
    };
    let counted = 0;
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        const r429 = op.responses["429"] as
          { headers?: Record<string, unknown> } | undefined;
        if (path.startsWith("/health/") || path === "/v1/rl-public/exempt") {
          expect(r429, `${method} ${path}`).toBeUndefined();
          continue;
        }
        counted += 1;
        expect(r429, `${method} ${path}`).toBeDefined();
        expect(r429?.headers, `${method} ${path}`).toHaveProperty(
          "Retry-After",
        );
      }
    }
    expect(counted).toBeGreaterThan(20);
  });
});
