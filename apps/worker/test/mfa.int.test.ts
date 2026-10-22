// P5-05 (phase ruling D5, ADR 0066; Done-when DW7), live: the
// users.mfa_check consumer against compose.yml's Postgres and Valkey
// (@bricx/db-bootstrap/stack) and the real P5-01 realm
// (@bricx/keycloak-realm/testing), with real bricx-client logins. The
// relay is the real one (production defaults) and the consumer the real
// BullMQ Worker; only the logger records. The rows are seeded as the test
// superuser, as the API's suites do; the outbox row is written as
// bricx_app, as the API does in the membership's transaction.
// - Assigning `accountant` (finance.* keys) maps bricx-mfa in the realm:
//   polled, the time from COMMIT to mfa.applied printed. Before the
//   mapping a login reaches acr pwd with no OTP step; after it the login
//   asks for OTP and the tokens carry acr mfa (the P5-01 flow, read
//   only: nothing here changes the realm).
// - Removal (the empty `member` role) clears the mapping; a check that
//   changes nothing logs changed false.
// - Keycloak paused: the admin call times out (the client's per-request
//   timeout, short here), the job is delayed by the topic's backoff (one
//   mfa.retry line, no status) and applies after the unpause.
// - A user the database or Keycloak does not know: mfa.user_missing, the
//   job completes.
import { execFileSync } from "node:child_process";
import { loadWorkerConfig } from "@bricx/config/worker";
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
  Browser,
  type Keycloak,
  type Page,
  type Tokens,
  claimsOf,
  createRealmUser,
  formAction,
  keycloakService,
  pkce,
  startKeycloak,
  tokenCall,
  totp,
  totpSecretOf,
} from "@bricx/keycloak-realm/testing";
import { ROLES } from "@bricx/permissions/roles";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type MfaConsumer,
  type MfaDeps,
  USERS_QUEUE,
  createMfaConsumer,
} from "../src/mfa/consumer.js";
import { mfaTruth } from "../src/mfa/truth.js";
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
  type KeycloakAdmin,
  MFA_ROLE,
  createKeycloakSessionEnder,
} from "../src/revocation/keycloak.js";
import { workerEnv } from "./env.js";
import { type Stack, startStack } from "./stack.js";

const HOOK_MS = 600_000;
const ORG_A = "0199e1a0-0000-7000-8000-00000000000a";
const ADMIN = "0199e1a0-0000-7000-8000-000000000002";
const USER = "0199e1a0-0000-7000-8000-000000000003";
/** A users row whose subject no realm user has. */
const GHOST = "0199e1a0-0000-7000-8000-000000000004";
/** No users row at all. */
const UNKNOWN = "0199e1a0-0000-7000-8000-000000000005";
const PASSWORD = "test-only-mfa-login-pw-1";
const USERNAME = "mfa-user";
const redirect = keycloakService.environment.KEYCLOAK_WEB_REDIRECT_URI ?? "";
const ids = createUuidV7Generator({ clock: { now: () => Date.now() } });
const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8" });

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
let sub: string;
let app: Database;
let relayDb: RelayDatabase;
let valkey: Redis;
let consumerValkey: Redis;
let relay: Relay;
let inspect: Queue<OutboxJobData>;
let admin: KeycloakAdmin;
const roles: Record<string, string> = {};
const relayLog = recorder();
const closers: (() => Promise<unknown>)[] = [];

async function asAdmin(text: string, params: unknown[] = []): Promise<void> {
  const client = await stack.postgres.admin();
  try {
    await client.query(text, params);
  } finally {
    await client.end();
  }
}

/** The open role `key` of ORG_A: a ROLE_IDS key gets its bundle, any other key is empty. */
async function seedRole(key: "accountant" | "member"): Promise<string> {
  const id = ids.next();
  await asAdmin(
    `INSERT INTO bricx.roles (id, org_id, key, name, system_key, created_at, updated_at)
     VALUES ($1, $2, $3, $3, $4, now(), now())`,
    [id, ORG_A, key, key === "member" ? null : key],
  );
  if (key !== "member") {
    for (const permission of ROLES[key]) {
      await asAdmin(
        `INSERT INTO bricx.role_permissions (id, org_id, role_id, permission, granted_at)
         VALUES ($1, $2, $3, $4, now())`,
        [ids.next(), ORG_A, id, permission],
      );
    }
  }
  return id;
}

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
  // The production relay: every option its default.
  relay = createRelay({
    database: relayDb,
    store: outboxStore,
    publisher,
    logger: relayLog,
  });
  relay.start();
  inspect = new Queue(USERS_QUEUE, { connection: valkey });
  admin = createKeycloakSessionEnder(config().keycloak);
  sub = await createRealmUser(keycloak, {
    username: USERNAME,
    password: PASSWORD,
    orgId: ORG_A,
  });
  for (const [id, keycloakSub] of [
    [USER, sub],
    [GHOST, "no-such-subject-sentinel-9b1e"],
  ]) {
    await asAdmin(
      `INSERT INTO bricx.users (id, keycloak_sub, created_at, last_seen_at)
       VALUES ($1, $2, now(), now())`,
      [id, keycloakSub],
    );
  }
  roles.accountant = await seedRole("accountant");
  roles.member = await seedRole("member");
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
function config() {
  return loadWorkerConfig(
    workerEnv({
      DATABASE_URL: stack.url("bricx_app"),
      RELAY_DATABASE_URL: stack.url("bricx_relay"),
      VALKEY_URL: stack.valkeyUrl(),
      KEYCLOAK_ISSUER: issuer,
    }),
  );
}

/** A consumer on the real queue with `deps` overrides; closed by the caller. */
function consumer(
  overrides: Partial<MfaDeps> = {},
): MfaConsumer & { log: ReturnType<typeof recorder> } {
  const log = recorder();
  const c = createMfaConsumer({
    connection: consumerValkey,
    deps: {
      truth: mfaTruth(relayDb),
      keycloak: admin,
      logger: log,
      ...overrides,
    },
  });
  return Object.assign(c, { log });
}

/**
 * Closes the user's open memberships in ORG_A and opens one with `role`
 * (the superuser, as the API's suites seed), then commits one
 * users.mfa_check row as bricx_app, as the API does.
 */
async function assign(
  userId: string,
  role: keyof typeof roles | undefined,
): Promise<{ outboxId: string; committedAt: number }> {
  await asAdmin(
    `UPDATE bricx.memberships SET removed_at = now()
     WHERE org_id = $1 AND user_id = $2 AND removed_at IS NULL`,
    [ORG_A, userId],
  );
  if (role !== undefined) {
    await asAdmin(
      `INSERT INTO bricx.memberships (id, org_id, user_id, role_id, created_at)
       VALUES ($1, $2, $3, $4, now())`,
      [ids.next(), ORG_A, userId, roles[role]],
    );
  }
  return check(userId);
}

/** Commits one users.mfa_check row for `userId` as bricx_app. */
async function check(
  userId: string,
): Promise<{ outboxId: string; committedAt: number }> {
  const outboxId = ids.next();
  await app.withTx({ orgId: ORG_A, userId: ADMIN, projectIds: [] }, (tx) =>
    insertOutbox(tx, "users.mfa_check", { userId }, outboxId),
  );
  return { outboxId, committedAt: performance.now() };
}

/** The names of the realm roles mapped to the test user, read as the realm admin. */
async function realmRoles(): Promise<string[]> {
  const mapped = await keycloak.admin(
    "GET",
    `/users/${sub}/role-mappings/realm`,
  );
  if (!Array.isArray(mapped)) throw new Error("role mappings: not a list");
  const list: unknown[] = mapped;
  const names: string[] = [];
  for (const role of list) {
    if (
      typeof role === "object" &&
      role !== null &&
      "name" in role &&
      typeof role.name === "string"
    ) {
      names.push(role.name);
    }
  }
  return names.sort();
}

const line = (
  log: ReturnType<typeof recorder>,
  msg: string,
  outboxId: string,
) => log.lines.find((l) => l.msg === msg && l.fields.outboxId === outboxId);

/** Waits for the line; a timeout reports what the consumer logged instead (ids and counts only). */
async function awaitLine(
  log: ReturnType<typeof recorder>,
  msg: string,
  outboxId: string,
  timeoutMs = 30_000,
): Promise<Logged> {
  try {
    return await waitFor(
      msg,
      () => Promise.resolve(line(log, msg, outboxId)),
      timeoutMs,
      20,
    );
  } catch (error) {
    throw new Error(`${String(error)}; logged: ${JSON.stringify(log.lines)}`, {
      cause: error,
    });
  }
}

/**
 * A browser login as the test user: password, then OTP when the flow asks
 * for it (the P5-01 flow; the secret Keycloak shows at setup is used once).
 */
async function signIn(): Promise<{ tokens: Tokens; otpAsked: boolean }> {
  const browser = new Browser(keycloak.base);
  const { verifier, challenge } = pkce();
  const query = new URLSearchParams({
    client_id: "bricx-client",
    redirect_uri: redirect,
    response_type: "code",
    scope: "openid",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state",
    nonce: "nonce",
  });
  const login = await browser.request(
    `/realms/bricx/protocol/openid-connect/auth?${query.toString()}`,
  );
  expect(login.status).toBe(200);
  let page: Page = await browser.follow(
    await browser.request(formAction(login), {
      username: USERNAME,
      password: PASSWORD,
      credentialId: "",
    }),
  );
  const secret = totpSecretOf(page);
  if (secret !== undefined) {
    page = await browser.follow(
      await browser.request(formAction(page), {
        totp: totp(secret, Date.now()),
        totpSecret: secret,
        userLabel: "test",
        mode: "",
      }),
    );
  }
  expect(page.status).toBe(302);
  expect(page.location.startsWith(redirect)).toBe(true);
  const code = new URL(page.location).searchParams.get("code") ?? "";
  const tokens = await tokenCall(keycloak, keycloak.base, {
    grant_type: "authorization_code",
    client_id: "bricx-client",
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
  });
  return { tokens, otpAsked: secret !== undefined };
}

describe("the consumer, live (DW7)", () => {
  test("assigning accountant maps bricx-mfa: polled, the time printed; a login before reaches acr pwd without OTP, after it asks OTP and reaches acr mfa", async () => {
    expect(await realmRoles()).not.toContain(MFA_ROLE);
    const before = await signIn();
    expect(before.otpAsked).toBe(false);
    expect(claimsOf(before.tokens.access_token).acr).toBe("pwd");

    const c = consumer();
    try {
      const { outboxId, committedAt } = await assign(USER, "accountant");
      const applied = await awaitLine(c.log, "mfa.applied", outboxId);
      const elapsedMs = Math.round(performance.now() - committedAt);
      process.stdout.write(
        `[P5-05] COMMIT to mfa.applied (production relay, idlePollMs ${String(RELAY_DEFAULTS.idlePollMs)}): ${String(elapsedMs)} ms\n`,
      );
      expect(applied.fields).toEqual({
        outboxId,
        userId: USER,
        required: true,
        changed: true,
        attempt: 1,
      });
      expect(await realmRoles()).toContain(MFA_ROLE);
      const job = await inspect.getJob(outboxId);
      expect(await job?.getState()).toBe("completed");
      expect(job?.opts.attempts).toBe(
        OUTBOX_TOPICS["users.mfa_check"]?.delivery?.attempts,
      );
      expect(JSON.stringify(c.log.lines)).not.toContain(sub);
    } finally {
      await c.close();
    }

    const after = await signIn();
    expect(after.otpAsked).toBe(true);
    expect(claimsOf(after.tokens.access_token).acr).toBe("mfa");
  });

  test("the empty member role clears the mapping; a second check changes nothing (changed false)", async () => {
    const c = consumer();
    try {
      const cleared = await assign(USER, "member");
      const applied = await awaitLine(c.log, "mfa.applied", cleared.outboxId);
      expect(applied.fields).toEqual({
        outboxId: cleared.outboxId,
        userId: USER,
        required: false,
        changed: true,
        attempt: 1,
      });
      expect(await realmRoles()).not.toContain(MFA_ROLE);
      const again = await check(USER);
      const same = await awaitLine(c.log, "mfa.applied", again.outboxId);
      expect(same.fields).toMatchObject({ required: false, changed: false });
      expect(await (await inspect.getJob(again.outboxId))?.getState()).toBe(
        "completed",
      );
    } finally {
      await c.close();
    }
  });

  test("Keycloak paused: the call times out, the job is delayed by the topic's backoff (one mfa.retry line, no status), then applies after the unpause", async () => {
    // A short per-request timeout, so the paused Keycloak fails the attempt here and not after the production 30 s.
    const impatient = createKeycloakSessionEnder(config().keycloak, {
      requestTimeoutMs: 2_000,
    });
    const c = consumer({ keycloak: impatient });
    const id = keycloak.container.getId();
    let paused = false;
    try {
      docker("pause", id);
      paused = true;
      const { outboxId } = await assign(USER, "accountant");
      const retry = await awaitLine(c.log, "mfa.retry", outboxId);
      expect(retry).toEqual({
        level: "debug",
        msg: "mfa.retry",
        fields: { outboxId, userId: USER, attempt: 1, status: undefined },
      });
      const job = await inspect.getJob(outboxId);
      expect(["delayed", "waiting", "active"]).toContain(await job?.getState());
      expect(job?.attemptsMade).toBeGreaterThanOrEqual(1);
      expect(job?.delay).toBe(1_000);
      docker("unpause", id);
      paused = false;
      const applied = await awaitLine(c.log, "mfa.applied", outboxId, 60_000);
      process.stdout.write(
        `[P5-05] applied after the unpause on attempt ${String(applied.fields.attempt)}\n`,
      );
      expect(applied.fields).toMatchObject({
        userId: USER,
        required: true,
        changed: true,
      });
      expect(applied.fields.attempt).toBeGreaterThan(1);
      expect(await realmRoles()).toContain(MFA_ROLE);
      expect(JSON.stringify(c.log.lines)).not.toMatch(/abort|timeout/i);
    } finally {
      if (paused) docker("unpause", id);
      await c.close();
    }
  });

  test("a users row Keycloak does not know, and no users row at all: mfa.user_missing, the job completes", async () => {
    const c = consumer();
    try {
      const ghost = await assign(GHOST, "accountant");
      const missing = await awaitLine(
        c.log,
        "mfa.user_missing",
        ghost.outboxId,
      );
      expect(missing.fields).toEqual({
        outboxId: ghost.outboxId,
        userId: GHOST,
        where: "keycloak",
      });
      expect(await (await inspect.getJob(ghost.outboxId))?.getState()).toBe(
        "completed",
      );
      const unknown = await check(UNKNOWN);
      const none = await awaitLine(c.log, "mfa.user_missing", unknown.outboxId);
      expect(none.fields).toEqual({
        outboxId: unknown.outboxId,
        userId: UNKNOWN,
        where: "database",
      });
      expect(await (await inspect.getJob(unknown.outboxId))?.getState()).toBe(
        "completed",
      );
    } finally {
      await c.close();
    }
  });
});
