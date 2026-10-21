// P5-03 (ADR 0063; owner conditions 4 and 7; phase ruling D6): the
// AuthGuard's session and device tracking against compose.yml's Postgres
// with the production journal, as bricx_app, with tokens from the local
// test issuer (every token carries a sid).
// - The first request for (org, sid) inserts one sessions row (user, no
//   device) and the identity carries its id; later requests reuse it;
//   the same sid in another org is another row; last_seen_at moves at
//   most once per throttle (on the injected Clock).
// - A revoked session is 401 session_expired (session_revoked); an idle
//   one (last_seen_at older than the idle limit) is 401 session_expired
//   (session_idle) and is closed: revoked_at is set, so the next request
//   is session_revoked.
// - The org value can only shorten the realm's 12 h (OrgSessionPolicy):
//   600 s idles after 600 s; 100 000 s is clamped to 43 200; a value that
//   is not a positive integer falls back to 43 200 (condition 7).
// - X-Device-Id: a registered device of the user binds the session and
//   reaches the identity; unknown, another user's or revoked devices are
//   401 unauthenticated (device_unknown / device_revoked) and write no
//   session row; a session bound to one device refuses another
//   (device_mismatch); a request without the header is accepted.
// - A token without sid is 401 (token_malformed) and writes nothing.
import { Writable } from "node:stream";
import { loadApiConfig } from "@bricx/config/api";
import {
  type BootstrappedPostgres,
  appDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { migrate } from "@bricx/db/migrate";
import { Controller, Get } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import {
  type OrgSessionPolicy,
  REALM_IDLE_SECONDS,
} from "../src/common/auth/session-policy.js";
import { currentRequestContext } from "../src/common/db/request-context.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";
import {
  TestIssuer,
  bearer,
  roleGrants,
  seedDevices,
  seedUsers,
} from "./support/auth.js";

const HOOK_MS = 300_000;
const ORG_A = "0199e1a0-0000-7000-8000-0000000000a1";
const ORG_B = "0199e1a0-0000-7000-8000-0000000000b1";
const ORG_SHORT = "0199e1a0-0000-7000-8000-0000000000c1";
const ORG_LONG = "0199e1a0-0000-7000-8000-0000000000d1";
const ORG_BAD = "0199e1a0-0000-7000-8000-0000000000e1";
const U1 = "0199e1a0-0000-7000-8000-000000000101";
const U2 = "0199e1a0-0000-7000-8000-000000000102";
const SUB1 = "sessions-user-1";
const SUB2 = "sessions-user-2";
const D1 = "0199e1a0-0000-7000-8000-0000000000d1";
const D1B = "0199e1a0-0000-7000-8000-0000000000d2";
const D2 = "0199e1a0-0000-7000-8000-0000000000d3";
const D_REVOKED = "0199e1a0-0000-7000-8000-0000000000d4";
const D_UNKNOWN = "0199e1a0-0000-7000-8000-0000000000d9";
const THROTTLE_SECONDS = 60;
const SID_SENTINEL = "sid-sentinel-7c2a";

@Controller({ path: "whoami", version: "1" })
class WhoAmIController {
  @Get()
  get() {
    const ctx = currentRequestContext();
    return {
      identity: ctx?.identity ?? null,
      headerDevice: ctx?.deviceId ?? null,
    };
  }
}

let pg18: BootstrappedPostgres;
let issuer: TestIssuer;
let app: NestFastifyApplication;
const lines: string[] = [];
// A clock the test moves: fixed at start so a value computed in the test
// equals what the tracker stored, then offset to cross the throttle and
// the idle limits.
const BASE_MS = Date.now();
const clock = { offsetMs: 0, now: () => BASE_MS + clock.offsetMs };
/** The org values the test policy answers (anything else: the realm's). */
const orgIdle = new Map<string, unknown>([
  [ORG_SHORT, 600],
  [ORG_LONG, 100_000],
  [ORG_BAD, -1],
]);
const policy: OrgSessionPolicy & { calls: string[] } = {
  calls: [],
  idleSeconds(orgId) {
    policy.calls.push(orgId);
    // The policy port hands the org's raw value back; the tracker clamps.
    return Promise.resolve(orgIdle.get(orgId) ?? REALM_IDLE_SECONDS);
  },
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

interface SessionRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  user_id: string;
  device_id: string | null;
  keycloak_sid: string;
  last_seen_at: string;
  revoked_at: string | null;
}
const sessionsOf = (sid: string) =>
  asAdmin<SessionRow>(
    `SELECT id::text, org_id::text, user_id::text, device_id::text, keycloak_sid,
            to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_seen_at,
            revoked_at::text
     FROM bricx.sessions WHERE keycloak_sid = $1 ORDER BY org_id`,
    [sid],
  );

beforeAll(async () => {
  [pg18, issuer] = await Promise.all([startPostgres(), TestIssuer.start()]);
  await migrate({
    reveal: () => urlFor("bricx_owner", "BRICX_OWNER_PASSWORD"),
  });
  await seedUsers(asAdmin, [
    { id: U1, sub: SUB1 },
    { id: U2, sub: SUB2 },
  ]);
  await seedDevices(asAdmin, [
    { id: D1, userId: U1 },
    { id: D1B, userId: U1 },
    { id: D2, userId: U2 },
    { id: D_REVOKED, userId: U1, revokedAt: new Date().toISOString() },
  ]);
  app = await createApp(
    loadApiConfig(
      apiEnv({
        ...issuer.env(),
        DATABASE_URL: urlFor("bricx_app", "BRICX_APP_PASSWORD"),
        USERS_LAST_SEEN_THROTTLE_SECONDS: String(THROTTLE_SECONDS),
      }),
    ),
    {
      probes: fakeProbes(),
      logStream: new Writable({
        write(chunk: Buffer, _encoding, done) {
          lines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
          done();
        },
      }),
      extraControllers: [WhoAmIController],
      grantsSource: roleGrants(),
      sessionPolicy: policy,
      clock,
    },
  );
  await app.init();
}, HOOK_MS);

afterAll(async () => {
  await app.close().catch(() => undefined);
  await issuer.close();
  await pg18.container.stop();
}, HOOK_MS);

let sidCounter = 0;
const newSid = () => {
  sidCounter += 1;
  return `${SID_SENTINEL}-${String(sidCounter)}`;
};

const whoami = (headers: Record<string, string>) =>
  app.inject({ method: "GET", url: "/v1/whoami", headers });
// Tokens are minted on the test clock, so moving it past the idle limit
// idles the session rather than expiring the token.
const tokenFor = (org: string, sid: string, sub = SUB1) => {
  const iat = Math.floor(clock.now() / 1000);
  return issuer.token({ sub, org_id: org, sid, iat, exp: iat + 300 });
};

const logged = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
const reasons = () =>
  logged()
    .filter((l) => l.msg === "auth.failed")
    .map((l) => l.reason);
const started = () => logged().filter((l) => l.msg === "auth.session_started");

interface Body {
  identity: {
    userId: string;
    orgId: string;
    sessionId: string;
    deviceId?: string;
  } | null;
  headerDevice: string | null;
}
const bodyOf = (body: string) => JSON.parse(body) as Body;

function expectExpired(res: {
  statusCode: number;
  headers: Record<string, unknown>;
  json: () => unknown;
}) {
  expect(res.statusCode).toBe(401);
  expect(res.headers["www-authenticate"]).toBe("Bearer");
  expect(res.json()).toMatchObject({ status: 401, code: "session_expired" });
}
function expect401(res: {
  statusCode: number;
  headers: Record<string, unknown>;
  json: () => unknown;
}) {
  expect(res.statusCode).toBe(401);
  expect(res.headers["www-authenticate"]).toBe("Bearer");
  expect(res.json()).toMatchObject({ status: 401, code: "unauthenticated" });
}

describe("one sessions row per (org, sid)", () => {
  test("the first request inserts the row (user, no device); the identity carries its id; the second reuses it; one auth.session_started line, no sid in the log", async () => {
    const sid = newSid();
    const before = started().length;
    const first = await whoami(bearer(await tokenFor(ORG_A, sid)));
    expect(first.statusCode).toBe(200);
    const rows = await sessionsOf(sid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      org_id: ORG_A,
      user_id: U1,
      device_id: null,
      keycloak_sid: sid,
      revoked_at: null,
    });
    expect(bodyOf(first.body).identity).toMatchObject({
      userId: U1,
      orgId: ORG_A,
      sessionId: rows[0]?.id,
    });
    expect(bodyOf(first.body).identity?.deviceId).toBeUndefined();
    const second = await whoami(bearer(await tokenFor(ORG_A, sid)));
    expect(second.statusCode).toBe(200);
    expect(bodyOf(second.body).identity?.sessionId).toBe(rows[0]?.id);
    expect(await sessionsOf(sid)).toHaveLength(1);
    const lines = started().slice(before);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      sessionId: rows[0]?.id,
      userId: U1,
      orgId: ORG_A,
    });
    expect(JSON.stringify(logged())).not.toContain(SID_SENTINEL);
  });

  test("ten parallel first requests for one sid: one row, one id, one auth.session_started line (the insert race)", async () => {
    const sid = newSid();
    const before = started().length;
    const token = await tokenFor(ORG_A, sid);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => whoami(bearer(token))),
    );
    for (const res of results) expect(res.statusCode).toBe(200);
    const rows = await sessionsOf(sid);
    expect(rows).toHaveLength(1);
    expect(
      new Set(results.map((r) => bodyOf(r.body).identity?.sessionId)),
    ).toEqual(new Set([rows[0]?.id]));
    expect(started().slice(before)).toHaveLength(1);
  });

  test("the same sid signed into another org is another row, with its own id", async () => {
    const sid = newSid();
    const a = await whoami(bearer(await tokenFor(ORG_A, sid)));
    const b = await whoami(bearer(await tokenFor(ORG_B, sid)));
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const rows = await sessionsOf(sid);
    expect(rows.map((r) => r.org_id)).toEqual([ORG_A, ORG_B]);
    expect(bodyOf(a.body).identity?.sessionId).toBe(rows[0]?.id);
    expect(bodyOf(b.body).identity?.sessionId).toBe(rows[1]?.id);
    expect(rows[0]?.id).not.toBe(rows[1]?.id);
  });

  test("last_seen_at moves at most once per USERS_LAST_SEEN_THROTTLE_SECONDS, on the Clock", async () => {
    const sid = newSid();
    clock.offsetMs = 0;
    const t0 = new Date(clock.now()).toISOString();
    expect((await whoami(bearer(await tokenFor(ORG_A, sid)))).statusCode).toBe(
      200,
    );
    const [row] = await sessionsOf(sid);
    expect(row?.last_seen_at).toBe(t0);
    try {
      clock.offsetMs = (THROTTLE_SECONDS - 1) * 1000;
      expect(
        (await whoami(bearer(await tokenFor(ORG_A, sid)))).statusCode,
      ).toBe(200);
      expect((await sessionsOf(sid))[0]?.last_seen_at).toBe(t0);
      clock.offsetMs = (THROTTLE_SECONDS + 1) * 1000;
      const t1 = new Date(clock.now()).toISOString();
      expect(
        (await whoami(bearer(await tokenFor(ORG_A, sid)))).statusCode,
      ).toBe(200);
      expect((await sessionsOf(sid))[0]?.last_seen_at).toBe(t1);
    } finally {
      clock.offsetMs = 0;
    }
  });

  test("a token without sid is 401 (token_malformed) and writes no row", async () => {
    const before = reasons().length;
    const count = async () =>
      (
        await asAdmin<{ n: number }>(
          "SELECT count(*)::int AS n FROM bricx.sessions",
        )
      )[0]?.n;
    const n = await count();
    expect401(
      await whoami(
        bearer(
          await issuer.token({ sub: SUB1, org_id: ORG_A, sid: undefined }),
        ),
      ),
    );
    expect(reasons().slice(before)).toEqual(["token_malformed"]);
    expect(await count()).toBe(n);
  });
});

describe("revoked and idle sessions (D6)", () => {
  test("a revoked session is 401 session_expired (session_revoked), and stays so", async () => {
    const sid = newSid();
    expect((await whoami(bearer(await tokenFor(ORG_A, sid)))).statusCode).toBe(
      200,
    );
    await asAdmin(
      "UPDATE bricx.sessions SET revoked_at = now() WHERE keycloak_sid = $1",
      [sid],
    );
    const before = reasons().length;
    expectExpired(await whoami(bearer(await tokenFor(ORG_A, sid))));
    expectExpired(await whoami(bearer(await tokenFor(ORG_A, sid))));
    expect(reasons().slice(before)).toEqual([
      "session_revoked",
      "session_revoked",
    ]);
    expect(await sessionsOf(sid)).toHaveLength(1);
  });

  test("an idle session (realm limit 12 h) is 401 session_expired (session_idle) and is closed; the next request is session_revoked", async () => {
    const sid = newSid();
    clock.offsetMs = 0;
    expect((await whoami(bearer(await tokenFor(ORG_A, sid)))).statusCode).toBe(
      200,
    );
    try {
      // Inside the limit: fine (and last_seen_at moves, past the throttle).
      clock.offsetMs = (REALM_IDLE_SECONDS - 1) * 1000;
      expect(
        (await whoami(bearer(await tokenFor(ORG_A, sid)))).statusCode,
      ).toBe(200);
      // Past the limit since that request: idle.
      clock.offsetMs += (REALM_IDLE_SECONDS + 1) * 1000;
      const closedAt = new Date(clock.now()).toISOString();
      const before = reasons().length;
      expectExpired(await whoami(bearer(await tokenFor(ORG_A, sid))));
      const [row] = await sessionsOf(sid);
      expect(row?.revoked_at).not.toBeNull();
      expect(new Date(row?.revoked_at ?? "").toISOString()).toBe(closedAt);
      clock.offsetMs += 1000;
      expectExpired(await whoami(bearer(await tokenFor(ORG_A, sid))));
      expect(reasons().slice(before)).toEqual([
        "session_idle",
        "session_revoked",
      ]);
    } finally {
      clock.offsetMs = 0;
    }
  });

  test("an org value of 600 s shortens the limit: idle after 601 s, fine at 599 s", async () => {
    const sid = newSid();
    clock.offsetMs = 0;
    expect(
      (await whoami(bearer(await tokenFor(ORG_SHORT, sid)))).statusCode,
    ).toBe(200);
    expect(policy.calls).toContain(ORG_SHORT);
    try {
      clock.offsetMs = 599 * 1000;
      expect(
        (await whoami(bearer(await tokenFor(ORG_SHORT, sid)))).statusCode,
      ).toBe(200);
      clock.offsetMs += 601 * 1000;
      const before = reasons().length;
      expectExpired(await whoami(bearer(await tokenFor(ORG_SHORT, sid))));
      expect(reasons().slice(before)).toEqual(["session_idle"]);
    } finally {
      clock.offsetMs = 0;
    }
  });

  test("an org value above 12 h (100 000 s) cannot lengthen it: still idle after 43 201 s", async () => {
    const sid = newSid();
    clock.offsetMs = 0;
    expect(
      (await whoami(bearer(await tokenFor(ORG_LONG, sid)))).statusCode,
    ).toBe(200);
    try {
      clock.offsetMs = (REALM_IDLE_SECONDS + 1) * 1000;
      const before = reasons().length;
      expectExpired(await whoami(bearer(await tokenFor(ORG_LONG, sid))));
      expect(reasons().slice(before)).toEqual(["session_idle"]);
    } finally {
      clock.offsetMs = 0;
    }
  });

  test("an org value that is not a positive integer (-1) falls back to the realm's 12 h (condition 7)", async () => {
    const sid = newSid();
    clock.offsetMs = 0;
    expect(
      (await whoami(bearer(await tokenFor(ORG_BAD, sid)))).statusCode,
    ).toBe(200);
    try {
      clock.offsetMs = (REALM_IDLE_SECONDS - 1) * 1000;
      expect(
        (await whoami(bearer(await tokenFor(ORG_BAD, sid)))).statusCode,
      ).toBe(200);
      clock.offsetMs += (REALM_IDLE_SECONDS + 1) * 1000;
      expectExpired(await whoami(bearer(await tokenFor(ORG_BAD, sid))));
    } finally {
      clock.offsetMs = 0;
    }
  });
});

describe("X-Device-Id (owner condition 4)", () => {
  test("a registered device of the user binds the session and reaches the identity; the header alone is never trusted", async () => {
    const sid = newSid();
    const res = await whoami({
      ...bearer(await tokenFor(ORG_A, sid)),
      "x-device-id": D1,
    });
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res.body)).toMatchObject({
      identity: { sessionId: expect.any(String) as string, deviceId: D1 },
      headerDevice: D1,
    });
    expect((await sessionsOf(sid))[0]?.device_id).toBe(D1);
  });

  test.each([
    ["an unknown device", D_UNKNOWN, "device_unknown"],
    ["another user's device", D2, "device_unknown"],
    ["a revoked device", D_REVOKED, "device_revoked"],
  ])(
    "%s is 401 unauthenticated (%s) and writes no session row",
    async (_what, device, reason) => {
      const sid = newSid();
      const before = reasons().length;
      expect401(
        await whoami({
          ...bearer(await tokenFor(ORG_A, sid)),
          "x-device-id": device,
        }),
      );
      expect(reasons().slice(before)).toEqual([reason]);
      expect(await sessionsOf(sid)).toEqual([]);
    },
  );

  test("a session started without a device is bound by the first request that carries a registered one; a request without the header keeps working", async () => {
    const sid = newSid();
    expect((await whoami(bearer(await tokenFor(ORG_A, sid)))).statusCode).toBe(
      200,
    );
    expect((await sessionsOf(sid))[0]?.device_id).toBeNull();
    const bound = await whoami({
      ...bearer(await tokenFor(ORG_A, sid)),
      "x-device-id": D1,
    });
    expect(bound.statusCode).toBe(200);
    expect((await sessionsOf(sid))[0]?.device_id).toBe(D1);
    const bare = await whoami(bearer(await tokenFor(ORG_A, sid)));
    expect(bare.statusCode).toBe(200);
    expect(bodyOf(bare.body).identity?.deviceId).toBeUndefined();
    expect((await sessionsOf(sid))[0]?.device_id).toBe(D1);
  });

  test("a session bound to one device refuses another registered device of the same user (device_mismatch); the binding stays", async () => {
    const sid = newSid();
    expect(
      (
        await whoami({
          ...bearer(await tokenFor(ORG_A, sid)),
          "x-device-id": D1,
        })
      ).statusCode,
    ).toBe(200);
    const before = reasons().length;
    expect401(
      await whoami({
        ...bearer(await tokenFor(ORG_A, sid)),
        "x-device-id": D1B,
      }),
    );
    expect(reasons().slice(before)).toEqual(["device_mismatch"]);
    expect((await sessionsOf(sid))[0]?.device_id).toBe(D1);
    expect(
      (
        await whoami({
          ...bearer(await tokenFor(ORG_A, sid)),
          "x-device-id": D1,
        })
      ).statusCode,
    ).toBe(200);
  });
});
