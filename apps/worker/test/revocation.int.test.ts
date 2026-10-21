// P5-04 (ADR 0065), live: the sessions.revoked consumer against
// compose.yml's Postgres, Valkey (@bricx/db-bootstrap/stack) and the real
// P5-01 realm (@bricx/keycloak-realm/testing), with a real bricx-client
// login. The relay is the real one (production defaults) and the consumer
// the real BullMQ Worker; only the logger records.
// - Owner condition 1: a row written under org B (the administrator's
//   request) carries the session's org A in its payload: the keys are
//   revoked:sid:A:<sid> and revoked:user:A:<userId>, nothing under B, with
//   the TTL (330 s default, at least 305), and the Keycloak session is
//   gone: its refresh token is refused. The time from COMMIT to
//   revocation.applied is printed.
// - Idempotent: a second job for a session Keycloak no longer holds
//   completes (404 caught) and re-sets the keys. A self revoke sets the
//   sid key only.
// - Decision 8: a Keycloak failure leaves the keys set and the job delayed
//   by the topic's backoff (1 s), one revocation.retry line.
// - Owner condition 3: the service account's token is requested up front;
//   a wrong secret is refused, and the secret never reaches the message.
// Owner condition 2 (what bricx-worker can and cannot do) is the live
// probe in tooling/keycloak-realm's realm-import.int.test.ts (ADR 0060 3b).
import {
  Secret,
  WORKER_CLIENT_ID,
  loadWorkerConfig,
} from "@bricx/config/worker";
import { waitFor } from "@bricx/db-bootstrap/stack";
import {
  type Database,
  type RelayDatabase,
  openDatabase,
  openRelayDatabase,
} from "@bricx/db/database";
import { OUTBOX_TOPICS, insertOutbox } from "@bricx/db/outbox";
import { createUuidV7Generator } from "@bricx/ids/uuid-v7";
import {
  type Keycloak,
  type Tokens,
  claimsOf,
  createRealmUser,
  passwordLogin,
  startKeycloak,
} from "@bricx/keycloak-realm/testing";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createBullPublisher } from "../src/relay/publisher.js";
import {
  type OutboxJobData,
  type Relay,
  RELAY_DEFAULTS,
  type RelayLogger,
  createRelay,
} from "../src/relay/relay.js";
import { outboxStore } from "../src/relay/store.js";
import { openConsumerValkey, openValkey } from "../src/relay/valkey.js";
import {
  type RevocationConsumer,
  type RevocationDeps,
  createRevocationConsumer,
} from "../src/revocation/consumer.js";
import {
  type SessionEnder,
  createKeycloakSessionEnder,
} from "../src/revocation/keycloak.js";
import { workerEnv } from "./env.js";
import { type Stack, startStack } from "./stack.js";

const HOOK_MS = 600_000;
const ORG_A = "0199e1a0-0000-7000-8000-00000000000a";
const ORG_B = "0199e1a0-0000-7000-8000-00000000000b";
const USER = "0199e1a0-0000-7000-8000-000000000001";
const ADMIN = "0199e1a0-0000-7000-8000-000000000002";
const PASSWORD = "test-only-worker-login-pw-1";
const ids = createUuidV7Generator({ clock: { now: () => Date.now() } });

interface Logged {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  fields: Record<string, unknown>;
}
function recorder(): RelayLogger & { lines: Logged[] } {
  const lines: Logged[] = [];
  const at =
    (level: Logged["level"]) =>
    (fields: Record<string, unknown>, msg: string) => {
      lines.push({ level, msg, fields });
    };
  return {
    lines,
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
}

let stack: Stack;
let keycloak: Keycloak;
let issuer: string;
let app: Database;
let relayDb: RelayDatabase;
let valkey: Redis;
let consumerValkey: Redis;
let relay: Relay;
let inspect: Queue<OutboxJobData>;
let ender: SessionEnder;
const relayLog = recorder();
const closers: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  [stack, keycloak] = await Promise.all([startStack(), startKeycloak()]);
  issuer = `${keycloak.base}/realms/bricx`;
  app = openDatabase({ reveal: () => stack.url("bricx_app") });
  relayDb = openRelayDatabase({ reveal: () => stack.url("bricx_relay") });
  valkey = openValkey({ reveal: () => stack.valkeyUrl() });
  await valkey.connect();
  consumerValkey = openConsumerValkey({ reveal: () => stack.valkeyUrl() });
  const publisher = createBullPublisher(valkey);
  closers.push(() => publisher.close());
  // The production relay: every option its default (owner condition 4).
  relay = createRelay({
    database: relayDb,
    store: outboxStore,
    publisher,
    logger: relayLog,
  });
  relay.start();
  inspect = new Queue("sessions", { connection: valkey });
  ender = createKeycloakSessionEnder(config().keycloak);
  await createRealmUser(keycloak, {
    username: "revoked-user",
    password: PASSWORD,
    orgId: ORG_A,
  });
}, HOOK_MS);

afterAll(async () => {
  await relay.stop();
  for (const close of closers.reverse()) await close();
  await inspect.close();
  valkey.disconnect();
  consumerValkey.disconnect();
  await relayDb.close();
  await app.close();
  await Promise.all([stack.stop(), keycloak.container.stop()]);
}, HOOK_MS);

/** The worker's config for this stack (the realm's dev secret, .env.example). */
function config(overrides: Record<string, string> = {}) {
  return loadWorkerConfig(
    workerEnv({
      DATABASE_URL: stack.url("bricx_app"),
      RELAY_DATABASE_URL: stack.url("bricx_relay"),
      VALKEY_URL: stack.valkeyUrl(),
      KEYCLOAK_ISSUER: issuer,
      ...overrides,
    }),
  );
}

/** A consumer on the real queue with `deps` overrides; closed by the caller. */
function consumer(
  overrides: Partial<RevocationDeps> = {},
): RevocationConsumer & { log: ReturnType<typeof recorder> } {
  const log = recorder();
  const c = createRevocationConsumer({
    connection: consumerValkey,
    deps: {
      keys: {
        async set(key, ttlSeconds) {
          await valkey.set(key, "1", "EX", ttlSeconds);
        },
      },
      keycloak: ender,
      logger: log,
      ttlSeconds: config().revocation.ttlSeconds,
      ...overrides,
    },
  });
  return Object.assign(c, { log });
}

/** A real login as the test user; the token's sid is the Keycloak session. */
async function login(): Promise<Tokens & { sid: string }> {
  const tokens = await passwordLogin(keycloak, {
    username: "revoked-user",
    password: PASSWORD,
  });
  const sid = claimsOf(tokens.access_token).sid;
  if (typeof sid !== "string") throw new Error("the token has no sid");
  return { ...tokens, sid };
}

/** Commits one sessions.revoked row under `rowOrg` for a session of ORG_A. */
async function revoke(
  rowOrg: string,
  sid: string,
  cause: "self" | "device" | "admin",
): Promise<{ outboxId: string; sessionId: string; committedAt: number }> {
  const outboxId = ids.next();
  const sessionId = ids.next();
  await app.withTx({ orgId: rowOrg, userId: ADMIN, projectIds: [] }, (tx) =>
    insertOutbox(
      tx,
      "sessions.revoked",
      { sessionId, userId: USER, orgId: ORG_A, keycloakSid: sid, cause },
      outboxId,
    ),
  );
  return { outboxId, sessionId, committedAt: performance.now() };
}

/** The refresh grant's status: 200 while the session lives, 400 once ended. */
async function refreshStatus(tokens: Tokens): Promise<number> {
  const response = await keycloak.fetch(
    `${issuer}/protocol/openid-connect/token`,
    {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "bricx-client",
        refresh_token: tokens.refresh_token,
      }),
    },
  );
  return response.status;
}

const applied = (log: ReturnType<typeof recorder>, outboxId: string) =>
  log.lines.find(
    (l) => l.msg === "revocation.applied" && l.fields.outboxId === outboxId,
  );

describe("the service account's token (owner condition 3)", () => {
  test("ensureToken() succeeds with the realm's secret; a wrong secret is refused and never reaches the message", async () => {
    await expect(ender.ensureToken()).resolves.toBeUndefined();
    const wrong = "wrong-secret-sentinel-8d2f-personal";
    const bad = createKeycloakSessionEnder({
      issuer,
      workerClientId: WORKER_CLIENT_ID,
      workerClientSecret: new Secret(wrong),
    });
    let error: unknown;
    try {
      await bad.ensureToken();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(wrong);
    expect(
      JSON.stringify(error, Object.getOwnPropertyNames(error)),
    ).not.toContain(wrong);
  });
});

describe("the consumer, live", () => {
  test("an admin revoke under org B: org A's sid and user keys with the TTL, nothing under B, the Keycloak session ended; time to applied printed", async () => {
    const c = consumer();
    try {
      const session = await login();
      expect(await refreshStatus(session)).toBe(200);
      const { outboxId, sessionId, committedAt } = await revoke(
        ORG_B,
        session.sid,
        "admin",
      );
      const line = await waitFor(
        "revocation.applied",
        () => Promise.resolve(applied(c.log, outboxId)),
        30_000,
        20,
      );
      const elapsedMs = Math.round(performance.now() - committedAt);
      process.stdout.write(
        `[P5-04] COMMIT to revocation.applied (production relay, idlePollMs ${String(RELAY_DEFAULTS.idlePollMs)}): ${String(elapsedMs)} ms\n`,
      );
      expect(line.fields).toEqual({
        outboxId,
        sessionId,
        userId: USER,
        orgId: ORG_A,
        cause: "admin",
        attempt: 1,
      });
      const ttl = config().revocation.ttlSeconds;
      expect(ttl).toBe(330);
      for (const key of [
        `revoked:sid:${ORG_A}:${session.sid}`,
        `revoked:user:${ORG_A}:${USER}`,
      ]) {
        const left = await valkey.ttl(key);
        expect(left).toBeGreaterThan(ttl - 30);
        expect(left).toBeLessThanOrEqual(ttl);
      }
      expect(await valkey.keys(`revoked:*:${ORG_B}:*`)).toEqual([]);
      expect(await refreshStatus(session)).toBe(400);
      expect(JSON.stringify(c.log.lines)).not.toContain(session.sid);
      expect(JSON.stringify(c.log.lines)).not.toContain(ORG_B);
      const job = await inspect.getJob(outboxId);
      expect(await job?.getState()).toBe("completed");
      expect(job?.opts.attempts).toBe(
        OUTBOX_TOPICS["sessions.revoked"]?.delivery?.attempts,
      );
    } finally {
      await c.close();
    }
  });

  test("idempotent: a second job for the ended session completes (404 caught) and re-sets the keys; a self revoke sets the sid key only", async () => {
    const c = consumer();
    try {
      // The admin case above barred the user for the TTL; this case is
      // about the sid key alone.
      await valkey.del(`revoked:user:${ORG_A}:${USER}`);
      const session = await login();
      const first = await revoke(ORG_A, session.sid, "self");
      await waitFor(
        "the first applied",
        () => Promise.resolve(applied(c.log, first.outboxId)),
        30_000,
        20,
      );
      expect(await refreshStatus(session)).toBe(400);
      expect(await valkey.exists(`revoked:sid:${ORG_A}:${session.sid}`)).toBe(
        1,
      );
      expect(await valkey.exists(`revoked:user:${ORG_A}:${USER}`)).toBe(0);
      await valkey.del(`revoked:sid:${ORG_A}:${session.sid}`);
      const second = await revoke(ORG_A, session.sid, "self");
      await waitFor(
        "the second applied",
        () => Promise.resolve(applied(c.log, second.outboxId)),
        30_000,
        20,
      );
      expect(await valkey.exists(`revoked:sid:${ORG_A}:${session.sid}`)).toBe(
        1,
      );
      expect(await (await inspect.getJob(second.outboxId))?.getState()).toBe(
        "completed",
      );
    } finally {
      await c.close();
    }
  });

  test("a Keycloak failure (decision 8): the keys are set, the job is delayed by the topic's backoff (1 s), one revocation.retry line without the sid", async () => {
    const failing = Object.assign(new Error("gateway sentinel-7f1c-personal"), {
      response: { status: 502 },
    });
    const c = consumer({
      keycloak: { endSession: () => Promise.reject(failing) },
    });
    try {
      const session = await login();
      const { outboxId, sessionId } = await revoke(ORG_A, session.sid, "admin");
      const retry = await waitFor(
        "revocation.retry",
        () =>
          Promise.resolve(
            c.log.lines.find(
              (l) =>
                l.msg === "revocation.retry" && l.fields.outboxId === outboxId,
            ),
          ),
        30_000,
        20,
      );
      expect(retry).toEqual({
        level: "debug",
        msg: "revocation.retry",
        fields: { outboxId, sessionId, attempt: 1, status: 502 },
      });
      expect(await valkey.exists(`revoked:sid:${ORG_A}:${session.sid}`)).toBe(
        1,
      );
      const job = await inspect.getJob(outboxId);
      expect(await job?.getState()).toBe("delayed");
      expect(job?.attemptsMade).toBe(1);
      expect(job?.delay).toBe(1_000);
      expect(JSON.stringify(c.log.lines)).not.toContain("sentinel-7f1c");
      expect(JSON.stringify(c.log.lines)).not.toContain(session.sid);
      // The session still lives: Keycloak was never reached.
      expect(await refreshStatus(session)).toBe(200);
      await c.close();
      // Nothing else should take the job: drop it, then end the session.
      await job?.remove();
      await ender.endSession(session.sid);
      expect(await refreshStatus(session)).toBe(400);
    } finally {
      await c.close();
    }
  });
});
