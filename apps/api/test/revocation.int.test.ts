// P5-04 Done when, live (ADR 0065; plan decision 9 as changed by owner
// conditions 1, 4 and 5): "revoked user's next API call returns 401
// within 1 s; next sync token request fails". The real app (real
// AuthGuard, real ValkeyRevocationStore) against compose.yml's Postgres
// and Valkey (@bricx/db-bootstrap/stack), the real P5-01 realm
// (@bricx/keycloak-realm/testing, real bricx-client logins) and the BUILT
// worker (apps/worker, `node --import dist/register.js dist/main.js`)
// with its production defaults: the relay's 250 ms idle poll (condition
// 4) and the sessions.revoked consumer. Hooks get 600 s.
// (a) DB path: DELETE /v1/sessions/:id, then the same token's next
//     request is 401 session_expired with no wait.
// (b) Valkey sid path: the revocation keys appear within 1 s of the
//     revoke response (polled every 25 ms, the number printed); the
//     sessions row is then deleted with the Testcontainers superuser
//     connection (condition 5, a retention job's effect): the token is
//     still 401 from the key alone and no row is re-inserted.
// (c) Valkey user path (condition 1): an org-A administrator's
//     POST /v1/users/:userId/sessions/revoke; the user's fresh login
//     (a new Keycloak session, a new sid) in org A is 401 within 1 s of
//     the response (printed), and stays refused for the TTL; the same
//     user's fresh login in org B works at once.
// (d) The Keycloak session is ended: the revoked login's refresh token is
//     refused (invalid_grant).
// (e) assertSessionActive() (phase ruling D10): a live session passes, a
//     revoked one and an unknown one are session_expired.
// Nothing logs a Keycloak session id, a token or the worker's secret.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { Writable } from "node:stream";
import { loadApiConfig } from "@bricx/config/api";
import { workerKeys } from "@bricx/config/worker";
import {
  type BootstrappedPostgres,
  type StartedValkey,
  appDatabase,
  exampleValue,
  startPostgres,
  startValkey,
  waitFor,
} from "@bricx/db-bootstrap/stack";
import { migrate } from "@bricx/db/migrate";
import { isObject } from "@bricx/keycloak-realm/normalise";
import {
  type Keycloak,
  type RealmUser,
  type Tokens,
  claimsOf,
  createRealmUser,
  passwordLogin,
  startKeycloak,
} from "@bricx/keycloak-realm/testing";
import { Controller, Get, HttpCode, Inject, Param } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { NoPermission } from "../src/common/auth/can.decorator.js";
import { createApp } from "../src/app.js";
import {
  type SessionsActivePort,
  SessionsService,
} from "../src/modules/sessions/public-api.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";
import { bearer, roleGrants, seedUsers } from "./support/auth.js";

const HOOK_MS = 600_000;
const BUDGET_MS = 1_000;
const POLL_MS = 25;
const ORG_A = "0199e1a0-0000-7000-8000-0000000000a1";
const ORG_B = "0199e1a0-0000-7000-8000-0000000000b1";
const USER = "0199e1a0-0000-7000-8000-0000000000a2";
const ADMIN = "0199e1a0-0000-7000-8000-0000000000e2";
const PASSWORD = "test-only-revocation-pw-1";
const workerDir = path.resolve(import.meta.dirname, "../../worker");

/** The sync token endpoint's call (P8-01), as a test route. */
@NoPermission("test-only probe")
@Controller({ path: "sync-probe", version: "1" })
class SyncProbeController {
  constructor(
    @Inject(SessionsService) private readonly sessions: SessionsActivePort,
  ) {}

  @Get(":id")
  @HttpCode(204)
  async get(@Param("id") id: string) {
    await this.sessions.assertSessionActive(id);
  }
}

let pg18: BootstrappedPostgres;
let valkey: StartedValkey;
let keycloak: Keycloak;
let issuer: string;
let app: NestFastifyApplication;
let admin: Redis;
let worker: { child: ChildProcess; output: () => string };
let user: RealmUser & { sub: string };
let administrator: RealmUser & { sub: string };
const apiLines: string[] = [];

const urlFor = (role: string, key: string) =>
  `postgres://${role}:${exampleValue(key)}@${pg18.container.getHost()}:${String(pg18.container.getMappedPort(5432))}/${appDatabase}`;

async function asSuperuser<R extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  const client = await pg18.admin();
  try {
    return (await client.query<R>(text, params)).rows;
  } finally {
    await client.end();
  }
}

/** The built worker with its production defaults on this stack. */
function startWorker(): typeof worker {
  execFileSync(
    process.execPath,
    [
      path.resolve(workerDir, "../../node_modules/typescript/bin/tsc"),
      "-p",
      path.join(workerDir, "tsconfig.build.json"),
    ],
    { cwd: workerDir, stdio: "pipe" },
  );
  const env: Record<string, string> = {};
  for (const key of workerKeys) {
    try {
      env[key] = exampleValue(key);
    } catch {
      // An optional key .env.example does not set.
    }
  }
  Object.assign(env, {
    NODE_ENV: "test",
    LOG_LEVEL: "info",
    DATABASE_URL: urlFor("bricx_app", "BRICX_APP_PASSWORD"),
    RELAY_DATABASE_URL: urlFor("bricx_relay", "BRICX_RELAY_PASSWORD"),
    VALKEY_URL: valkey.url(),
    KEYCLOAK_ISSUER: issuer,
  });
  const child = spawn(
    process.execPath,
    [
      "--import",
      path.join(workerDir, "dist/register.js"),
      path.join(workerDir, "dist/main.js"),
    ],
    {
      cwd: workerDir,
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: "pipe",
    },
  );
  let out = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
  child.stderr.on("data", (d: Buffer) => (out += d.toString("utf8")));
  return { child, output: () => out };
}

beforeAll(async () => {
  [pg18, valkey, keycloak] = await Promise.all([
    startPostgres(),
    startValkey(),
    startKeycloak(),
  ]);
  issuer = `${keycloak.base}/realms/bricx`;
  await migrate({
    reveal: () => urlFor("bricx_owner", "BRICX_OWNER_PASSWORD"),
  });
  const people = {
    user: { username: "revoked-user", password: PASSWORD, orgId: ORG_A },
    administrator: {
      username: "org-a-admin",
      password: PASSWORD,
      orgId: ORG_A,
    },
  };
  user = { ...people.user, sub: await createRealmUser(keycloak, people.user) };
  administrator = {
    ...people.administrator,
    sub: await createRealmUser(keycloak, people.administrator),
  };
  // Known ids for the realm users (the guard reuses a row for its sub).
  await seedUsers(asSuperuser, [
    { id: USER, sub: user.sub },
    { id: ADMIN, sub: administrator.sub },
  ]);
  admin = new Redis(valkey.url(), { maxRetriesPerRequest: 1 });
  admin.on("error", () => undefined);
  worker = startWorker();
  app = await createApp(
    loadApiConfig(
      apiEnv({
        KEYCLOAK_ISSUER: issuer,
        DATABASE_URL: urlFor("bricx_app", "BRICX_APP_PASSWORD"),
        VALKEY_URL: valkey.url(),
      }),
    ),
    {
      probes: fakeProbes(),
      logStream: new Writable({
        write(chunk: Buffer, _encoding, done) {
          apiLines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
          done();
        },
      }),
      extraControllers: [SyncProbeController],
      grantsSource: roleGrants({ [ADMIN]: { roles: ["owner"] } }),
    },
  );
  await app.init();
  await waitFor(
    "worker.started",
    () =>
      Promise.resolve(
        worker.output().includes("worker.started") ? true : undefined,
      ),
    120_000,
  );
}, HOOK_MS);

afterAll(async () => {
  worker.child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    worker.child.on("close", () => {
      resolve();
    });
  });
  await app.close().catch(() => undefined);
  admin.disconnect();
  await Promise.all([
    keycloak.container.stop(),
    valkey.stop(),
    pg18.container.stop(),
  ]);
}, HOOK_MS);

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function login(
  who: RealmUser,
): Promise<Tokens & { sid: string; row: () => Promise<string | undefined> }> {
  const tokens = await passwordLogin(keycloak, who);
  const sid = claimsOf(tokens.access_token).sid;
  if (typeof sid !== "string") throw new Error("the token has no sid");
  const org = claimsOf(tokens.access_token).org_id;
  return {
    ...tokens,
    sid,
    row: async () =>
      (
        await asSuperuser<{ id: string }>(
          "SELECT id::text FROM bricx.sessions WHERE keycloak_sid = $1 AND org_id = $2",
          [sid, org],
        )
      )[0]?.id,
  };
}

const call = (token: string, method: "GET" | "DELETE" | "POST", url: string) =>
  app.inject({ method, url, headers: bearer(token) });

const mine = (token: string) => call(token, "GET", "/v1/sessions");

/** ms until `token`'s request is `status`, polling every 25 ms (or -1). */
async function msUntil(
  token: string,
  status: number,
  since: bigint,
  limitMs = 10_000,
): Promise<number> {
  for (;;) {
    const res = await mine(token);
    const elapsed = Number(process.hrtime.bigint() - since) / 1e6;
    if (res.statusCode === status) return Math.round(elapsed);
    if (elapsed > limitMs) return -1;
    await sleep(POLL_MS);
  }
}

/** ms until the key exists, polling every 25 ms (or -1). */
async function msUntilKey(key: string, since: bigint): Promise<number> {
  for (;;) {
    const found = (await admin.exists(key)) === 1;
    const elapsed = Number(process.hrtime.bigint() - since) / 1e6;
    if (found) return Math.round(elapsed);
    if (elapsed > 10_000) return -1;
    await sleep(POLL_MS);
  }
}

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

/** Changes the user's default-org hint (the whole representation: a partial PUT clears the profile). */
async function setDefaultOrg(sub: string, orgId: string): Promise<void> {
  const current = await keycloak.admin("GET", `/users/${sub}`);
  if (!isObject(current)) throw new Error("the realm user was not found");
  const attributes = current.attributes;
  await keycloak.admin("PUT", `/users/${sub}`, {
    ...current,
    attributes: {
      ...(isObject(attributes) ? attributes : {}),
      org_id: [orgId],
    },
  });
}

const print = (what: string, ms: number) => {
  process.stdout.write(`[P5-04] ${what}: ${String(ms)} ms\n`);
};

describe("Done when: a revoked user's next API call is 401 within 1 s", () => {
  test("(a)+(b)+(d): DELETE /v1/sessions/:id: 401 at once from the row; the keys within 1 s; the row deleted as the superuser, still 401 and no new row; the refresh token refused", async () => {
    const session = await login(user);
    expect((await mine(session.access_token)).statusCode).toBe(200);
    const rowId = await session.row();
    if (rowId === undefined) throw new Error("no sessions row");
    const sidKey = `revoked:sid:${ORG_A}:${session.sid}`;
    expect(await admin.exists(sidKey)).toBe(0);

    const revoke = await call(
      session.access_token,
      "DELETE",
      `/v1/sessions/${rowId}`,
    );
    const since = process.hrtime.bigint();
    expect(revoke.statusCode).toBe(204);
    // (a) the DB path: no wait.
    const next = await mine(session.access_token);
    expect(next.statusCode).toBe(401);
    expect(next.json<{ code: string }>().code).toBe("session_expired");
    print(
      "(a) revoke response to the same token's 401 (DB row)",
      Math.round(Number(process.hrtime.bigint() - since) / 1e6),
    );
    // (b) the key, written by the worker from the outbox row.
    const keyMs = await msUntilKey(sidKey, since);
    print(
      "(b) revoke response to revoked:sid key present (relay 250 ms idle poll + consumer)",
      keyMs,
    );
    expect(keyMs).toBeGreaterThanOrEqual(0);
    expect(keyMs).toBeLessThanOrEqual(BUDGET_MS);
    const ttl = await admin.ttl(sidKey);
    expect(ttl).toBeGreaterThan(300);
    expect(ttl).toBeLessThanOrEqual(330);
    // A self revoke bars the session, not the user.
    expect(await admin.exists(`revoked:user:${ORG_A}:${USER}`)).toBe(0);
    // Condition 5: the row goes away as the Testcontainers superuser.
    await asSuperuser("DELETE FROM bricx.sessions WHERE id = $1", [rowId]);
    expect(await session.row()).toBeUndefined();
    const refused = await mine(session.access_token);
    expect(refused.statusCode).toBe(401);
    expect(refused.json<{ code: string }>().code).toBe("session_expired");
    expect(await session.row()).toBeUndefined();
    // (d) the Keycloak session is gone.
    await waitFor(
      "the refresh token refused",
      async () => ((await refreshStatus(session)) === 400 ? true : undefined),
      10_000,
      POLL_MS,
    );
  });

  test("(c)+(d): an org-A administrator's revoke-by-user: the user's fresh login in org A is 401 within 1 s and for the TTL; in org B it works at once (condition 1); the refresh token refused", async () => {
    const victim = await login(user);
    expect((await mine(victim.access_token)).statusCode).toBe(200);
    const boss = await login(administrator);
    const userKey = `revoked:user:${ORG_A}:${USER}`;
    expect(await admin.exists(userKey)).toBe(0);

    const revoke = await call(
      boss.access_token,
      "POST",
      `/v1/users/${USER}/sessions/revoke`,
    );
    const since = process.hrtime.bigint();
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json<{ revoked: string[] }>().revoked).toContain(
      await victim.row(),
    );
    // The revoked session itself: 401 at once from its row.
    expect((await mine(victim.access_token)).statusCode).toBe(401);
    // A fresh login (new Keycloak session, new sid): the key alone bars it.
    const fresh = await login(user);
    expect(fresh.sid).not.toBe(victim.sid);
    const ms = await msUntil(fresh.access_token, 401, since);
    print(
      "(c) revoke response to a fresh org-A login's 401 (revoked:user key)",
      ms,
    );
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThanOrEqual(BUDGET_MS);
    // Once the key is there a further fresh login is refused before any
    // sessions row is written.
    const later = await login(user);
    expect((await mine(later.access_token)).statusCode).toBe(401);
    expect(await later.row()).toBeUndefined();
    const ttl = await admin.ttl(userKey);
    expect(ttl).toBeGreaterThan(300);
    expect(ttl).toBeLessThanOrEqual(330);
    // Still refused later in the TTL.
    await sleep(500);
    expect((await mine(fresh.access_token)).statusCode).toBe(401);
    // Condition 1: org B at once.
    await setDefaultOrg(user.sub, ORG_B);
    try {
      const inB = await login(user);
      expect(claimsOf(inB.access_token).org_id).toBe(ORG_B);
      const ok = await mine(inB.access_token);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await admin.keys(`revoked:*:${ORG_B}:*`)).toEqual([]);
      // (e) assertSessionActive(): the live session passes, the revoked
      // and an unknown one are session_expired.
      const live = await inB.row();
      if (live === undefined) throw new Error("no org-B sessions row");
      expect(
        (await call(inB.access_token, "GET", `/v1/sync-probe/${live}`))
          .statusCode,
      ).toBe(204);
      const revokedRow = revoke.json<{ revoked: string[] }>().revoked[0];
      for (const id of [revokedRow, "0199e1a0-0000-7000-8000-0000000000ff"]) {
        const res = await call(
          inB.access_token,
          "GET",
          `/v1/sync-probe/${String(id)}`,
        );
        expect(res.statusCode).toBe(401);
        expect(res.json<{ code: string }>().code).toBe("session_expired");
      }
      await call(inB.access_token, "DELETE", `/v1/sessions/${live}`);
    } finally {
      await setDefaultOrg(user.sub, ORG_A);
    }
    // Back in org A: still refused within the TTL.
    const again = await login(user);
    expect((await mine(again.access_token)).statusCode).toBe(401);
    // (d) the revoked login's Keycloak session is gone.
    await waitFor(
      "the refresh token refused",
      async () => ((await refreshStatus(victim)) === 400 ? true : undefined),
      10_000,
      POLL_MS,
    );
  });

  test("no Keycloak session id, token or worker secret in the API's or the worker's output", () => {
    const out = worker.output();
    const api = apiLines.join("\n");
    expect(out).toContain("revocation.applied");
    for (const text of [out, api]) {
      expect(text).not.toContain(exampleValue("KEYCLOAK_WORKER_CLIENT_SECRET"));
      expect(text).not.toContain(exampleValue("VALKEY_PASSWORD"));
      expect(text).not.toContain(PASSWORD);
    }
    const sids = apiLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === "auth.failed")
      .map((line) => line.reason);
    expect(sids).toContain("revoked_user");
    expect(sids).toContain("revoked_sid");
  });
});
