// Rate limiting live (P6-05d, ADR 0080; owner conditions C1, C3, C4 and
// C5), against the dev stack's Valkey (compose.yml's own command line:
// noeviction) and, for the device burst, Postgres:
// - the Valkey store's Lua script counts per key and gives every key an
//   expiry: every rl:v1:* key the app writes has PTTL > 0 (C3), and a key
//   found without one (PTTL -1) gets it back on the next hit, not only on
//   the first (C4, S6);
// - a window ends and the caller is allowed again;
// - Valkey paused: default routes fall back in-process, the fail-closed
//   classes answer 503 server_unavailable, one warn line; unpaused, the
//   app counts in Valkey again;
// - C5: the revocation store and the limiter share one client; sharing
//   changes neither revocation's 500 ms bound nor its fail-closed answer,
//   even with limiter commands in flight, and closing the store leaves
//   the shared client to its owner;
// - C1 (b): 200 POST /v1/devices across one organisation in one window
//   (one address, 200 users) are all registered.
import { execFile } from "node:child_process";
import { Writable } from "node:stream";
import { promisify } from "node:util";
import { loadApiConfig } from "@bricx/config/api";
import {
  type BootstrappedPostgres,
  type StartedValkey,
  appDatabase,
  exampleValue,
  startPostgres,
  startValkey,
} from "@bricx/db-bootstrap/stack";
import { migrate } from "@bricx/db/migrate";
import { Controller, Get, HttpCode, Post } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { NoPermission } from "../src/common/auth/can.decorator.js";
import {
  REVOCATION_TIMEOUT_MS,
  RevocationUnavailable,
  ValkeyRevocationStore,
  revocationKeys,
} from "../src/common/auth/revocation-store.js";
import { DEVICE_ID_HEADER } from "../src/common/db/context.hook.js";
import { RateLimit } from "../src/common/rate-limit/rate-limit.decorator.js";
import {
  RateLimitStoreUnavailable,
  ValkeyRateLimitStore,
} from "../src/common/rate-limit/store.js";
import { openValkey } from "../src/common/valkey.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";
import {
  TestIssuer,
  type TestAccess,
  bearer,
  fixedRevocations,
  fixedSessions,
  fixedUsers,
  roleGrants,
  seedUsers,
  sidFor,
} from "./support/auth.js";

const HOOK_MS = 300_000;
const ORG = "0199e1a0-0000-7000-8000-0000000000a1";
const USER = "0199e1a0-0000-7000-8000-0000000000a2";
const SUB = "rl-int-user";
const KEY_SHAPE =
  /^rl:v1:(default|auth_adjacent|invitation|upload|export):(ip:[0-9a-f]{32}|user:[0-9a-f-]{36}|org:[0-9a-f-]{36})$/;

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
}

let valkey: StartedValkey;
let pg18: BootstrappedPostgres;
let issuer: TestIssuer;
let admin: Redis;
const secret = (url: string) => ({ reveal: () => url });
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  [valkey, pg18, issuer] = await Promise.all([
    startValkey(),
    startPostgres(),
    TestIssuer.start(),
  ]);
  admin = new Redis(valkey.url(), { maxRetriesPerRequest: 1 });
  admin.on("error", () => undefined);
}, HOOK_MS);

afterAll(async () => {
  admin.disconnect();
  await issuer.close();
  await Promise.all([valkey.stop(), pg18.container.stop()]);
}, HOOK_MS);

/** Pauses or unpauses the Valkey container (the daemon stops answering). */
async function pause(on: boolean): Promise<void> {
  await promisify(execFile)("docker", [
    on ? "pause" : "unpause",
    valkey.container.getId(),
  ]);
}

/** Every rl:v1:* key in Valkey with its PTTL. */
async function rateLimitKeys(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let cursor = "0";
  do {
    const [next, keys] = await admin.scan(
      cursor,
      "MATCH",
      "rl:v1:*",
      "COUNT",
      1000,
    );
    cursor = next;
    for (const key of keys) out.set(key, await admin.pttl(key));
  } while (cursor !== "0");
  return out;
}

interface Probe {
  readonly app: NestFastifyApplication;
  readonly lines: string[];
}

async function probeApp(env: Record<string, string> = {}): Promise<Probe> {
  const lines: string[] = [];
  const app = await createApp(
    loadApiConfig(
      apiEnv({ ...issuer.env(), VALKEY_URL: valkey.url(), ...env }),
    ),
    {
      probes: fakeProbes(),
      logStream: new Writable({
        write(chunk: Buffer, _encoding, done) {
          lines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
          done();
        },
      }),
      extraControllers: [ProbeController],
      userDirectory: fixedUsers({ [SUB]: USER }, USER),
      sessionTracker: fixedSessions(),
      revocationStore: fixedRevocations(),
      grantsSource: roleGrants(),
    },
  );
  await app.init();
  return { app, lines };
}

const token = () => issuer.token({ sub: SUB, org_id: ORG });

describe("the Valkey store", () => {
  test("counts per key, blocks over the limit, and gives the key the window as its expiry", async () => {
    const client = openValkey(secret(valkey.url()));
    const store = new ValkeyRateLimitStore(client);
    try {
      await admin.flushall();
      const key = `rl:v1:default:user:${USER}`;
      const first = await store.increment(key, 60_000, 2);
      expect(first).toMatchObject({ totalHits: 1, isBlocked: false });
      expect(first.timeToExpire).toBe(60);
      await store.increment(key, 60_000, 2);
      const third = await store.increment(key, 60_000, 2);
      expect(third).toMatchObject({ totalHits: 3, isBlocked: true });
      expect(third.timeToBlockExpire).toBeGreaterThanOrEqual(1);
      const pttl = await admin.pttl(key);
      expect(pttl).toBeGreaterThan(0);
      expect(pttl).toBeLessThanOrEqual(60_000);
    } finally {
      client.disconnect();
    }
  });

  test("C4: a key without an expiry (PTTL -1) gets one back on the next hit (S6)", async () => {
    const client = openValkey(secret(valkey.url()));
    const store = new ValkeyRateLimitStore(client);
    try {
      const key = `rl:v1:default:org:${ORG}`;
      await admin.set(key, "5");
      expect(await admin.pttl(key)).toBe(-1);
      const hit = await store.increment(key, 30_000, 100);
      expect(hit.totalHits).toBe(6);
      const pttl = await admin.pttl(key);
      expect(pttl).toBeGreaterThan(0);
      expect(pttl).toBeLessThanOrEqual(30_000);
    } finally {
      client.disconnect();
    }
  });

  test("C3: every rl:v1:* key the app writes has PTTL > 0 and the approved shape, no address", async () => {
    await admin.flushall();
    const { app } = await probeApp();
    try {
      for (let i = 0; i < 5; i += 1) {
        const headers = bearer(await token());
        await app.inject({ method: "GET", url: "/v1/rl/default", headers });
        await app.inject({
          method: "POST",
          url: "/v1/rl/auth-adjacent",
          headers,
        });
        await app.inject({ method: "GET", url: "/openapi.json" });
        await app.inject({
          method: "GET",
          url: "/v1/rl/default",
          headers: bearer("bad-token"),
          remoteAddress: "203.0.113.5",
        });
      }
      const keys = await rateLimitKeys();
      expect(keys.size).toBeGreaterThanOrEqual(5);
      for (const [key, pttl] of keys) {
        expect(key).toMatch(KEY_SHAPE);
        expect(key).not.toContain("127.0.0.1");
        expect(key).not.toContain("203.0.113.5");
        expect(pttl, key).toBeGreaterThan(0);
      }
    } finally {
      await app.close();
    }
  });

  test("after the window the caller is allowed again", async () => {
    await admin.flushall();
    const { app } = await probeApp({
      RATE_LIMIT_DEFAULT: "ip=1000,user=2,org=1000,window=1",
    });
    try {
      const get = async () =>
        (
          await app.inject({
            method: "GET",
            url: "/v1/rl/default",
            headers: bearer(await token()),
          })
        ).statusCode;
      expect([await get(), await get(), await get()]).toEqual([200, 200, 429]);
      await sleep(1_200);
      expect(await get()).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe("Valkey paused", () => {
  test("default routes fall back, auth_adjacent fails closed (503, Retry-After 5), one warn line each; unpaused, counting is in Valkey again", async () => {
    await admin.flushall();
    const { app, lines } = await probeApp();
    try {
      const headers = bearer(await token());
      expect(
        (await app.inject({ method: "GET", url: "/v1/rl/default", headers }))
          .statusCode,
      ).toBe(200);
      await pause(true);
      try {
        const open = await app.inject({
          method: "GET",
          url: "/v1/rl/default",
          headers,
        });
        expect(open.statusCode, open.body).toBe(200);
        const closed = await app.inject({
          method: "POST",
          url: "/v1/rl/auth-adjacent",
          headers,
        });
        expect(closed.statusCode, closed.body).toBe(503);
        expect(closed.headers["retry-after"]).toBe("5");
        expect(JSON.parse(closed.body)).toMatchObject({
          code: "server_unavailable",
        });
      } finally {
        await pause(false);
      }
      const warned = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((l) => l.msg === "rate_limit.store_unavailable")
        .map((l) => `${String(l.class)}/${String(l.mode)}`)
        .sort();
      expect(warned).toEqual([
        "auth_adjacent/fail_closed",
        "default/fail_open",
      ]);
      expect(lines.join("\n")).not.toContain(valkey.url());
      await admin.flushall();
      let status = 0;
      for (let i = 0; i < 20 && status !== 200; i += 1) {
        status = (
          await app.inject({
            method: "POST",
            url: "/v1/rl/auth-adjacent",
            headers,
          })
        ).statusCode;
        if (status !== 200) await sleep(100);
      }
      expect(status).toBe(200);
      expect((await rateLimitKeys()).size).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});

describe("P6-06 (ADR 0077, D9): the invitation class fails closed live", () => {
  test("POST /v1/invitations/activate (the real @Public route) is 503 server_unavailable with Retry-After 5 while Valkey is paused; unpaused, it answers again", async () => {
    await admin.flushall();
    const { app, lines } = await probeApp();
    const activate = () =>
      app.inject({
        method: "POST",
        url: "/v1/invitations/activate",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ token: "af-south-1.not-a-real-token" }),
      });
    try {
      expect((await activate()).statusCode).toBe(202);
      await pause(true);
      try {
        const closed = await activate();
        expect(closed.statusCode, closed.body).toBe(503);
        expect(closed.headers["retry-after"]).toBe("5");
        expect(JSON.parse(closed.body)).toMatchObject({
          code: "server_unavailable",
        });
      } finally {
        await pause(false);
      }
      expect(
        lines
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .filter((l) => l.msg === "rate_limit.store_unavailable")
          .map((l) => `${String(l.class)}/${String(l.mode)}`),
      ).toEqual(["invitation/fail_closed"]);
      let status = 0;
      for (let i = 0; i < 20 && status !== 202; i += 1) {
        status = (await activate()).statusCode;
        if (status !== 202) await sleep(100);
      }
      expect(status).toBe(202);
    } finally {
      await app.close();
    }
  });
});

describe("C5: one shared client", () => {
  test("revocation keeps its 500 ms bound and fails closed with limiter commands in flight; closing the store leaves the client open", async () => {
    const client = openValkey(secret(valkey.url()));
    const revocations = new ValkeyRevocationStore(client);
    const limiter = new ValkeyRateLimitStore(client);
    const input = { orgId: ORG, userId: USER, keycloakSid: "sid-c5" };
    try {
      await admin.flushall();
      expect(await revocations.check(input)).toBeUndefined();
      expect(
        (await limiter.increment(`rl:v1:default:user:${USER}`, 60_000, 10))
          .totalHits,
      ).toBe(1);
      await pause(true);
      try {
        const inFlight = Array.from({ length: 50 }, (_, i) =>
          limiter.increment(`rl:v1:default:user:${String(i)}`, 60_000, 10).then(
            () => "ok",
            (error: unknown) => error,
          ),
        );
        const started = performance.now();
        await expect(revocations.check(input)).rejects.toBeInstanceOf(
          RevocationUnavailable,
        );
        expect(performance.now() - started).toBeLessThan(
          REVOCATION_TIMEOUT_MS * 4,
        );
        for (const outcome of await Promise.all(inFlight)) {
          expect(outcome).toBeInstanceOf(RateLimitStoreUnavailable);
        }
      } finally {
        await pause(false);
      }
      await admin.set(revocationKeys(input).user, "1", "EX", 60);
      let answer: string | undefined;
      for (let i = 0; i < 20 && answer === undefined; i += 1) {
        try {
          answer = await revocations.check(input);
        } catch {
          await sleep(100);
        }
      }
      expect(answer).toBe("revoked_user");
      await revocations.close();
      expect(client.status).toBe("ready");
      expect(
        (await limiter.increment(`rl:v1:default:user:${USER}`, 60_000, 10))
          .totalHits,
      ).toBe(2);
    } finally {
      client.disconnect();
      await admin.flushall();
    }
  });

  test("the app's revocation store and limiter use the same connection", async () => {
    await admin.flushall();
    const app = await createApp(
      loadApiConfig(apiEnv({ ...issuer.env(), VALKEY_URL: valkey.url() })),
      {
        probes: fakeProbes(),
        extraControllers: [ProbeController],
        userDirectory: fixedUsers({ [SUB]: USER }, USER),
        sessionTracker: fixedSessions(),
        grantsSource: roleGrants(),
      },
    );
    await app.init();
    try {
      const before = Number(
        /connected_clients:(\d+)/.exec(await admin.info("clients"))?.[1],
      );
      const res = await app.inject({
        method: "GET",
        url: "/v1/rl/default",
        headers: bearer(await token()),
      });
      expect(res.statusCode, res.body).toBe(200);
      const after = Number(
        /connected_clients:(\d+)/.exec(await admin.info("clients"))?.[1],
      );
      expect(after - before).toBe(1);
      await admin.set(
        revocationKeys({ orgId: ORG, userId: USER, keycloakSid: sidFor(SUB) })
          .sid,
        "1",
        "EX",
        60,
      );
      const revoked = await app.inject({
        method: "GET",
        url: "/v1/rl/default",
        headers: bearer(await token()),
      });
      expect(revoked.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe("C1 (b): a shift start", () => {
  test("200 POST /v1/devices across one organisation in one window, from one address, are all registered", async () => {
    await admin.flushall();
    const urlFor = (role: string, key: string) =>
      `postgres://${role}:${exampleValue(key)}@${pg18.container.getHost()}:${String(pg18.container.getMappedPort(5432))}/${appDatabase}`;
    await migrate({
      reveal: () => urlFor("bricx_owner", "BRICX_OWNER_PASSWORD"),
    });
    const users = Array.from({ length: 200 }, (_, n) => ({
      id: `0199e1a0-0000-7000-8000-${(0x1000 + n).toString(16).padStart(12, "0")}`,
      sub: `shift-${String(n)}`,
    }));
    const asAdmin = async (text: string, params: unknown[] = []) => {
      const client = await pg18.admin();
      try {
        return (await client.query<Record<string, unknown>>(text, params)).rows;
      } finally {
        await client.end();
      }
    };
    await seedUsers(asAdmin, users);
    const access = new Map<string, TestAccess>(
      users.map((u) => [u.id, { roles: [] }]),
    );
    const app = await createApp(
      loadApiConfig(
        apiEnv({
          ...issuer.env(),
          VALKEY_URL: valkey.url(),
          DATABASE_URL: urlFor("bricx_app", "BRICX_APP_PASSWORD"),
        }),
      ),
      {
        probes: fakeProbes(),
        revocationStore: fixedRevocations(),
        grantsSource: roleGrants(access),
      },
    );
    await app.init();
    try {
      const statuses: number[] = [];
      for (const [n, user] of users.entries()) {
        const device = `0199e1a3-0000-7000-8000-${(0x1000 + n).toString(16).padStart(12, "0")}`;
        const res = await app.inject({
          method: "POST",
          url: "/v1/devices",
          headers: {
            ...bearer(
              await issuer.token({
                sub: user.sub,
                org_id: ORG,
                exp: Math.floor(Date.now() / 1000) + 3_600,
              }),
            ),
            [DEVICE_ID_HEADER]: device,
            "content-type": "application/json",
          },
          payload: JSON.stringify({
            id: device,
            platform: "android",
            name: "Site phone",
          }),
        });
        statuses.push(res.statusCode);
      }
      expect(statuses.filter((s) => s !== 201)).toEqual([]);
      const orgKey = (await rateLimitKeys()).get(
        `rl:v1:auth_adjacent:org:${ORG}`,
      );
      expect(orgKey).toBeGreaterThan(0);
      expect(await admin.get(`rl:v1:auth_adjacent:org:${ORG}`)).toBe("200");
    } finally {
      await app.close();
    }
  });
});
