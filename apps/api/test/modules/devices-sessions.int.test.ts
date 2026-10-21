// Devices and sessions end to end (P5-03, ADR 0063), against Postgres with
// the production journal, as bricx_app through the real app and the real
// AuthGuard (tokens from the local issuer; sessions rows come from the
// guard). Proves the approved plan's Done-whens and the owner's conditions:
// - POST /v1/devices registers the header's device (header == body id,
//   else 400), binds the current session, writes one org.device.register
//   audit event (ids only, condition 6) and no outbox row; the same id for
//   the same user is idempotent (201, unchanged); another user's id is 409;
//   a revoked device cannot be re-registered.
// - GET /v1/devices lists the caller's devices only (RLS own rows).
// - DELETE /v1/devices/:id closes the device and every open session of the
//   caller on it in every org (condition 2: one org.session.revoke audit
//   event in the request's org chain listing each session with its org,
//   one sessions.revoked outbox row per session under the request's org,
//   same transaction); another user's device is 404; a revoked device's
//   header is then 401; the closed sessions are 401 session_expired.
// - GET /v1/sessions lists the caller's sessions across orgs, `current`
//   marked; DELETE /v1/sessions/:id closes one (any org); 404 for another
//   user's.
// - Administrator routes: 403 with the production grants source (noGrants:
//   deny-all until P5-05); org.session.read.org lists a user's sessions in
//   this org only; org.session.revoke.org closes them in this org only
//   (condition 3: another user's session is not readable without the
//   grant, and the grant is org-scoped); a second revoke closes nothing
//   and writes nothing.
// - A failed revoke (the outbox insert made to fail) writes neither the
//   close nor the audit event (one transaction).
import { loadApiConfig } from "@bricx/config/api";
import {
  type BootstrappedPostgres,
  appDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { migrate } from "@bricx/db/migrate";
import { ErrorEnvelopeSchema } from "@bricx/validation/error-envelope";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../../src/app.js";
import { DEVICE_ID_HEADER } from "../../src/common/db/context.hook.js";
import { Device, DeviceList } from "../../src/modules/devices/devices.dto.js";
import {
  RevokedSessions,
  SessionList,
} from "../../src/modules/sessions/sessions.dto.js";
import { apiEnv } from "../env.js";
import { fakeProbes } from "../probes.js";
import {
  TestIssuer,
  type TestAccess,
  bearer,
  roleGrants,
  seedUsers,
} from "../support/auth.js";

const HOOK_MS = 300_000;
const ORG_A = "0199e1a0-0000-7000-8000-0000000000a1";
const ORG_B = "0199e1a0-0000-7000-8000-0000000000b1";
const ORG_C = "0199e1a0-0000-7000-8000-0000000000c1";
const USER_A = "0199e1a0-0000-7000-8000-0000000000a2";
const USER_B = "0199e1a0-0000-7000-8000-0000000000b2";
const ADMIN = "0199e1a0-0000-7000-8000-0000000000e2";
const NOBODY = "0199e1a0-0000-7000-8000-0000000000f2";
/** Registers devices against the capped app only (owner review fix 2). */
const USER_C = "0199e1a0-0000-7000-8000-0000000000c2";
/** Opens more sessions than the list cap (owner review fix 1). */
const USER_D = "0199e1a0-0000-7000-8000-0000000000d2";
/** The capped app's DEVICES_MAX_PER_USER. */
const DEVICE_CAP = 2;
const subOf = (user: string) => `devices-${user}`;

let idCounter = 0;
/** A fresh UUIDv7 (the device generates ids, CLAUDE.md rule 6). */
const newId = () => {
  idCounter += 1;
  return `0199e1a2-0000-7000-8000-${idCounter.toString(16).padStart(12, "0")}`;
};
let sidCounter = 0;
const newSid = () => {
  sidCounter += 1;
  return `devices-sid-${String(sidCounter)}`;
};

let pg18: BootstrappedPostgres;
let issuer: TestIssuer;
/** The app with the test-only grants source (roles per user). */
let app: NestFastifyApplication;
/** The app as production builds it: noGrants (deny-all). */
let production: NestFastifyApplication;
/** The app with DEVICES_MAX_PER_USER=2 (test-only grants source). */
let capped: NestFastifyApplication;
const access = new Map<string, TestAccess>();

const urlFor = (role: string, key: string) =>
  `postgres://${role}:${exampleValue(key)}@${pg18.container.getHost()}:${String(pg18.container.getMappedPort(5432))}/${appDatabase}`;

async function asAdmin<R extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  const admin = await pg18.admin();
  try {
    return (await admin.query<R>(text, params)).rows;
  } finally {
    await admin.end();
  }
}

beforeAll(async () => {
  [pg18, issuer] = await Promise.all([startPostgres(), TestIssuer.start()]);
  await migrate({
    reveal: () => urlFor("bricx_owner", "BRICX_OWNER_PASSWORD"),
  });
  await seedUsers(
    asAdmin,
    [USER_A, USER_B, ADMIN, USER_C, USER_D].map((id) => ({
      id,
      sub: subOf(id),
    })),
  );
  const url = urlFor("bricx_app", "BRICX_APP_PASSWORD");
  const config = loadApiConfig(apiEnv({ ...issuer.env(), DATABASE_URL: url }));
  app = await createApp(config, {
    probes: fakeProbes(),
    grantsSource: roleGrants(access),
  });
  await app.init();
  production = await createApp(config, { probes: fakeProbes() });
  await production.init();
  capped = await createApp(
    loadApiConfig(
      apiEnv({
        ...issuer.env(),
        DATABASE_URL: url,
        DEVICES_MAX_PER_USER: String(DEVICE_CAP),
      }),
    ),
    { probes: fakeProbes(), grantsSource: roleGrants(access) },
  );
  await capped.init();
}, HOOK_MS);
afterAll(async () => {
  await app.close().catch(() => undefined);
  await production.close().catch(() => undefined);
  await capped.close().catch(() => undefined);
  await issuer.close();
  await pg18.container.stop();
}, HOOK_MS);

interface As {
  readonly user: string;
  readonly org: string;
  readonly sid: string;
  readonly device?: string;
  readonly roles?: readonly string[];
}
const as = (user: string, org: string, extra: Partial<As> = {}): As => ({
  user,
  org,
  sid: newSid(),
  ...extra,
});

async function headersFor(who: As): Promise<Record<string, string>> {
  const token = await issuer.token({
    sub: subOf(who.user),
    org_id: who.org,
    sid: who.sid,
    exp: Math.floor(Date.now() / 1000) + 3_600,
  });
  access.set(who.user, { roles: who.roles ?? [] });
  return {
    ...bearer(token),
    ...(who.device === undefined ? {} : { [DEVICE_ID_HEADER]: who.device }),
  };
}

type Res = Awaited<ReturnType<NestFastifyApplication["inject"]>>;
const call = async (
  who: As,
  method: "GET" | "POST" | "DELETE",
  url: string,
  body?: unknown,
  target: NestFastifyApplication = app,
): Promise<Res> =>
  target.inject({
    method,
    url,
    headers: {
      ...(await headersFor(who)),
      // A JSON content type on a bodiless request is 400 request.malformed.
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });

function expectProblem(res: Res, status: number, code: string) {
  expect(res.statusCode).toBe(status);
  const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(res.body));
  expect(parsed.success).toBe(true);
  expect(parsed.data).toMatchObject({ status, code, key: `errors:${code}` });
}

/** Registers `device` for `who` (the header names it) and returns the body. */
async function register(
  who: As,
  device: string,
  name = "Site phone",
  target: NestFastifyApplication = app,
) {
  const res = await call(
    { ...who, device },
    "POST",
    "/v1/devices",
    { id: device, platform: "android", name },
    target,
  );
  expect(res.statusCode, res.body).toBe(201);
  return Device.schema.parse(JSON.parse(res.body));
}

/** The ids GET /v1/devices returns for `who` on `target`. */
async function listDevices(who: As, target: NestFastifyApplication = app) {
  const res = await call(who, "GET", "/v1/devices", undefined, target);
  expect(res.statusCode, res.body).toBe(200);
  return DeviceList.schema.parse(JSON.parse(res.body)).items;
}

/** Makes `who`'s session row exist (any authenticated request does). */
async function signIn(who: As): Promise<string> {
  const res = await call(who, "GET", "/v1/sessions");
  expect(res.statusCode, res.body).toBe(200);
  const { items } = SessionList.schema.parse(JSON.parse(res.body));
  const current = items.find((s) => s.current);
  if (current === undefined) throw new Error("no current session");
  return current.id;
}

interface SessionDb extends Record<string, unknown> {
  id: string;
  org_id: string;
  user_id: string;
  device_id: string | null;
  revoked_at: string | null;
}
const sessionRows = (user: string) =>
  asAdmin<SessionDb>(
    `SELECT id::text, org_id::text, user_id::text, device_id::text, revoked_at::text
     FROM bricx.sessions WHERE user_id = $1 ORDER BY id`,
    [user],
  );
interface AuditDb extends Record<string, unknown> {
  org_id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  actor_id: string;
  after: unknown;
}
const auditRows = (action: string) =>
  asAdmin<AuditDb>(
    `SELECT org_id::text, action, entity_type, entity_id::text, actor_id::text, after
     FROM bricx.audit_events WHERE action = $1 ORDER BY id`,
    [action],
  );
interface OutboxDb extends Record<string, unknown> {
  org_id: string;
  topic: string;
  payload: Record<string, unknown>;
}
const outboxRows = () =>
  asAdmin<OutboxDb>(
    `SELECT org_id::text, topic, payload FROM bricx.outbox WHERE topic = 'sessions.revoked' ORDER BY id`,
  );
interface Counts {
  readonly audit: number;
  readonly outbox: number;
}
const counts = async (): Promise<Counts> => {
  const [row] = await asAdmin<{ audit: number; outbox: number }>(
    `SELECT (SELECT count(*)::int FROM bricx.audit_events) AS audit,
            (SELECT count(*)::int FROM bricx.outbox) AS outbox`,
  );
  if (row === undefined) throw new Error("counts: no row");
  return row;
};

describe("POST /v1/devices (register; @RegistersDevice(), owner conditions 4 and 6)", () => {
  test("201: the row is the caller's, the current session is bound, one org.device.register audit event with ids only, no outbox row", async () => {
    const who = as(USER_A, ORG_A);
    const device = newId();
    const before = await counts();
    const body = await register(who, device, "Site phone");
    expect(body).toMatchObject({
      id: device,
      platform: "android",
      name: "Site phone",
      trusted: false,
      revokedAt: null,
    });
    const [row] = await asAdmin<{ user_id: string; trusted: boolean }>(
      "SELECT user_id::text, trusted FROM bricx.devices WHERE id = $1",
      [device],
    );
    expect(row).toEqual({ user_id: USER_A, trusted: false });
    const sessions = (await sessionRows(USER_A)).filter(
      (s) => s.org_id === ORG_A && s.device_id === device,
    );
    expect(sessions).toHaveLength(1);
    const audits = (await auditRows("org.device.register")).filter(
      (a) => a.entity_id === device,
    );
    expect(audits).toEqual([
      expect.objectContaining({
        org_id: ORG_A,
        entity_type: "org.device",
        actor_id: USER_A,
        after: { userId: USER_A, sessionId: sessions[0]?.id },
      }),
    ]);
    expect(JSON.stringify(audits)).not.toContain("Site phone");
    const after = await counts();
    expect(after.audit - before.audit).toBe(1);
    expect(after.outbox - before.outbox).toBe(0);
  });

  test("the same id again by the same user: 201 with the row unchanged, nothing written", async () => {
    const who = as(USER_A, ORG_A);
    const device = newId();
    const first = await register(who, device, "First name");
    const before = await counts();
    const again = await register(as(USER_A, ORG_B), device, "Second name");
    expect(again).toEqual(first);
    expect(await counts()).toEqual(before);
  });

  test("another user's id: 409 request.conflict, no row of mine", async () => {
    const device = newId();
    await register(as(USER_A, ORG_A), device);
    const res = await call(
      { ...as(USER_B, ORG_A), device },
      "POST",
      "/v1/devices",
      {
        id: device,
        platform: "ios",
        name: "Stolen id",
      },
    );
    expectProblem(res, 409, "request.conflict");
    const [row] = await asAdmin<{ user_id: string }>(
      "SELECT user_id::text FROM bricx.devices WHERE id = $1",
      [device],
    );
    expect(row?.user_id).toBe(USER_A);
  });

  test("the header must name the body's id: no header 400, another id 400; nothing written", async () => {
    const device = newId();
    const before = await counts();
    const body = { id: device, platform: "web", name: "Laptop" };
    expectProblem(
      await call(as(USER_A, ORG_A), "POST", "/v1/devices", body),
      400,
      "request.malformed",
    );
    const other = newId();
    await register(as(USER_A, ORG_A), other);
    expectProblem(
      await call(
        { ...as(USER_A, ORG_A), device: other },
        "POST",
        "/v1/devices",
        body,
      ),
      400,
      "request.malformed",
    );
    expect(
      await asAdmin("SELECT 1 FROM bricx.devices WHERE id = $1", [device]),
    ).toEqual([]);
    expect((await counts()).audit - before.audit).toBe(1); // `other`'s registration only
  });

  test("an invalid body: 422 validation_failed (platform outside the enum, name too long, unknown field)", async () => {
    const device = newId();
    for (const body of [
      { id: device, platform: "tv", name: "x" },
      { id: device, platform: "web", name: "n".repeat(101) },
      { id: device, platform: "web", name: "x", trusted: true },
    ]) {
      expectProblem(
        await call(
          { ...as(USER_A, ORG_A), device },
          "POST",
          "/v1/devices",
          body,
        ),
        422,
        "validation_failed",
      );
    }
    expect(
      await asAdmin("SELECT 1 FROM bricx.devices WHERE id = $1", [device]),
    ).toEqual([]);
  });

  test("a revoked device cannot be registered again: 409", async () => {
    const device = newId();
    await register(as(USER_A, ORG_A), device);
    expect(
      (await call(as(USER_A, ORG_A), "DELETE", `/v1/devices/${device}`))
        .statusCode,
    ).toBe(204);
    const res = await call(
      { ...as(USER_A, ORG_A), device },
      "POST",
      "/v1/devices",
      {
        id: device,
        platform: "android",
        name: "Back again",
      },
    );
    expectProblem(res, 409, "request.conflict");
  });
});

describe("GET /v1/devices and DELETE /v1/devices/:id", () => {
  test("lists the caller's devices only, by id", async () => {
    const mine = [newId(), newId()];
    const theirs = newId();
    for (const d of mine) await register(as(USER_A, ORG_A), d);
    await register(as(USER_B, ORG_A), theirs);
    const res = await call(as(USER_A, ORG_B), "GET", "/v1/devices");
    expect(res.statusCode).toBe(200);
    const { items } = DeviceList.schema.parse(JSON.parse(res.body));
    const ids = items.map((d) => d.id);
    expect(ids).toEqual([...ids].sort());
    for (const d of mine) expect(ids).toContain(d);
    expect(ids).not.toContain(theirs);
    const other = await call(as(USER_B, ORG_A), "GET", "/v1/devices");
    expect(
      DeviceList.schema.parse(JSON.parse(other.body)).items.map((d) => d.id),
    ).not.toContain(mine[0]);
  });

  test("revoke closes the device and every open session on it in every org (condition 2): one audit event in the request's org listing each session with its org, one outbox row per session under the request's org; then the header is 401 and the sessions are 401 session_expired", async () => {
    const device = newId();
    const sid = newSid();
    // Signed into A, B and C on this device; the revoke is made from A.
    await register({ ...as(USER_A, ORG_A), sid }, device);
    const onDevice = { device, sid };
    for (const org of [ORG_B, ORG_C]) {
      expect(
        (await call(as(USER_A, org, onDevice), "GET", "/v1/devices"))
          .statusCode,
      ).toBe(200);
    }
    const open = (await sessionRows(USER_A)).filter(
      (s) => s.device_id === device,
    );
    expect(open.map((s) => s.org_id).sort()).toEqual([ORG_A, ORG_B, ORG_C]);
    expect(open.every((s) => s.revoked_at === null)).toBe(true);
    const before = await counts();

    const res = await call(
      as(USER_A, ORG_A, onDevice),
      "DELETE",
      `/v1/devices/${device}`,
    );
    expect(res.statusCode, res.body).toBe(204);

    const [row] = await asAdmin<{ revoked_at: string | null }>(
      "SELECT revoked_at::text FROM bricx.devices WHERE id = $1",
      [device],
    );
    expect(row?.revoked_at).not.toBeNull();
    const closed = (await sessionRows(USER_A)).filter(
      (s) => s.device_id === device,
    );
    expect(closed.every((s) => s.revoked_at !== null)).toBe(true);
    const audits = (await auditRows("org.session.revoke")).filter(
      (a) => (a.after as { deviceId?: string }).deviceId === device,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      org_id: ORG_A,
      entity_type: "org.session",
      entity_id: null,
      actor_id: USER_A,
    });
    const listed = audits[0]?.after as {
      cause: string;
      sessions: { id: string; orgId: string }[];
    };
    expect(listed.cause).toBe("device");
    expect(listed.sessions.map((s) => s.orgId).sort()).toEqual([
      ORG_A,
      ORG_B,
      ORG_C,
    ]);
    expect(listed.sessions.map((s) => s.id).sort()).toEqual(
      open.map((s) => s.id).sort(),
    );
    const deviceAudits = (await auditRows("org.device.revoke")).filter(
      (a) => a.entity_id === device,
    );
    expect(deviceAudits).toHaveLength(1);
    expect(deviceAudits[0]?.org_id).toBe(ORG_A);
    const outbox = (await outboxRows()).filter((o) =>
      open.some((s) => s.id === o.payload.sessionId),
    );
    expect(outbox).toHaveLength(3);
    for (const o of outbox) {
      expect(o.org_id).toBe(ORG_A);
      const session = open.find((s) => s.id === o.payload.sessionId);
      expect(o.payload).toEqual({
        sessionId: session?.id,
        userId: USER_A,
        orgId: session?.org_id,
        keycloakSid: sid,
      });
    }
    const after = await counts();
    expect(after.audit - before.audit).toBe(2);
    expect(after.outbox - before.outbox).toBe(3);

    // The device header is refused everywhere now; the sessions are gone.
    expectProblem(
      await call(as(USER_A, ORG_A, onDevice), "GET", "/v1/devices"),
      401,
      "unauthenticated",
    );
    for (const org of [ORG_B, ORG_C]) {
      expectProblem(
        await call(as(USER_A, org, { sid }), "GET", "/v1/devices"),
        401,
        "session_expired",
      );
    }
    // Idempotent: a second revoke is 204 and writes nothing.
    expect(
      (await call(as(USER_A, ORG_A), "DELETE", `/v1/devices/${device}`))
        .statusCode,
    ).toBe(204);
    expect(await counts()).toEqual(after);
  });

  test("another user's device or an unknown id: 404 not_found, nothing written", async () => {
    const device = newId();
    await register(as(USER_B, ORG_A), device);
    const before = await counts();
    expectProblem(
      await call(as(USER_A, ORG_A), "DELETE", `/v1/devices/${device}`),
      404,
      "not_found",
    );
    expectProblem(
      await call(as(USER_A, ORG_A), "DELETE", `/v1/devices/${newId()}`),
      404,
      "not_found",
    );
    expectProblem(
      await call(as(USER_A, ORG_A), "DELETE", "/v1/devices/not-an-id"),
      422,
      "validation_failed",
    );
    const [row] = await asAdmin<{ revoked_at: string | null }>(
      "SELECT revoked_at::text FROM bricx.devices WHERE id = $1",
      [device],
    );
    expect(row?.revoked_at).toBeNull();
    expect(await counts()).toEqual(before);
  });
});

describe("the device cap (owner review fix 2): DEVICES_MAX_PER_USER non-revoked devices per user", () => {
  test("the third registration under a cap of 2 is 409 request.conflict with no row and no audit event; registering an existing id again is not a new device; revoking one frees a slot; GET lists the non-revoked devices only, at most the cap", async () => {
    const me = as(USER_C, ORG_A);
    const [d1, d2, d3] = [newId(), newId(), newId()];
    await register(me, d1, "One", capped);
    await register(me, d2, "Two", capped);
    const before = await counts();
    const res = await call(
      { ...me, device: d3 },
      "POST",
      "/v1/devices",
      { id: d3, platform: "ios", name: "Three" },
      capped,
    );
    expectProblem(res, 409, "request.conflict");
    expect(
      await asAdmin("SELECT id FROM bricx.devices WHERE id = $1", [d3]),
    ).toEqual([]);
    expect(await counts()).toEqual(before);
    // An existing id is idempotent even at the cap (it is one of the two).
    expect((await register(me, d1, "One again", capped)).name).toBe("One");
    expect((await listDevices(me, capped)).map((d) => d.id)).toEqual([d1, d2]);
    // Revoking one frees a slot (the revoke also closes `me`'s session,
    // which the first registration bound to d1: the rest runs on a new one).
    const revoke = await call(
      me,
      "DELETE",
      `/v1/devices/${d1}`,
      undefined,
      capped,
    );
    expect(revoke.statusCode).toBe(204);
    const fresh = as(USER_C, ORG_A);
    await register(fresh, d3, "Three", capped);
    const listed = await listDevices(fresh, capped);
    expect(listed.map((d) => d.id)).toEqual([d2, d3]);
    expect(listed.every((d) => d.revokedAt === null)).toBe(true);
    expect(listed.length).toBeLessThanOrEqual(DEVICE_CAP);
    // The same rows through the default app (cap 20): still no revoked row.
    expect((await listDevices(fresh)).map((d) => d.id)).toEqual([d2, d3]);
    // The fourth is refused again.
    expectProblem(
      await call(
        { ...fresh, device: d1 },
        "POST",
        "/v1/devices",
        { id: newId(), platform: "web", name: "Four" },
        capped,
      ),
      400,
      "request.malformed",
    );
    const d4 = newId();
    expectProblem(
      await call(
        { ...fresh, device: d4 },
        "POST",
        "/v1/devices",
        { id: d4, platform: "web", name: "Four" },
        capped,
      ),
      409,
      "request.conflict",
    );
  });

  test("the default cap is 20 (.env.example and the config default agree)", async () => {
    expect(exampleValue("DEVICES_MAX_PER_USER")).toBe("20");
    // Through the default app a user may hold 20 open devices and not 21.
    const me = as(USER_D, ORG_B);
    const ids = Array.from({ length: 20 }, () => newId());
    for (const id of ids) await register(me, id, "Fleet");
    const extra = newId();
    expectProblem(
      await call({ ...me, device: extra }, "POST", "/v1/devices", {
        id: extra,
        platform: "web",
        name: "Twenty-one",
      }),
      409,
      "request.conflict",
    );
    expect((await listDevices(me)).map((d) => d.id)).toEqual(ids);
  });
});

describe("GET /v1/sessions and DELETE /v1/sessions/:id (own sessions, every org)", () => {
  test("lists the caller's sessions across orgs with the current one marked; never another user's", async () => {
    const sid = newSid();
    const other = await signIn(as(USER_B, ORG_A));
    await signIn(as(USER_A, ORG_B, { sid }));
    const res = await call(as(USER_A, ORG_A, { sid }), "GET", "/v1/sessions");
    expect(res.statusCode).toBe(200);
    const { items } = SessionList.schema.parse(JSON.parse(res.body));
    expect(items.every((s) => s.userId === USER_A)).toBe(true);
    expect(items.map((s) => s.id)).not.toContain(other);
    expect(items.filter((s) => s.current)).toHaveLength(1);
    expect(items.find((s) => s.current)?.orgId).toBe(ORG_A);
    expect(items.some((s) => s.orgId === ORG_B && !s.current)).toBe(true);
    expect(res.body).not.toContain(sid);
  });

  test("lists open sessions only, newest first, at most 100 (owner review fix 1); the administrator's list the same", async () => {
    // 102 sessions for USER_D in org A (one request each: the guard inserts
    // the row), then one revoked: 101 open, 100 listed, the oldest dropped.
    const sids = Array.from({ length: 102 }, () => newSid());
    const ids: string[] = [];
    for (const sid of sids) ids.push(await signIn(as(USER_D, ORG_A, { sid })));
    expect(new Set(ids).size).toBe(102);
    const ascending = [...ids].sort();
    expect(ids).toEqual(ascending); // UUIDv7: creation order
    const [oldest, revoked] = [ascending[0], ascending[50]];
    if (oldest === undefined || revoked === undefined) throw new Error("ids");
    const [, secondSid] = sids;
    if (secondSid === undefined) throw new Error("sids");
    const closing = as(USER_D, ORG_A, { sid: secondSid });
    expect(
      (await call(closing, "DELETE", `/v1/sessions/${revoked}`)).statusCode,
    ).toBe(204);
    const res = await call(closing, "GET", "/v1/sessions");
    expect(res.statusCode).toBe(200);
    const { items } = SessionList.schema.parse(JSON.parse(res.body));
    expect(items).toHaveLength(100);
    const listed = items.map((s) => s.id);
    expect(listed).toEqual([...listed].sort().reverse()); // newest first
    expect(listed).not.toContain(revoked);
    expect(listed).not.toContain(oldest);
    expect(listed[0]).toBe(ascending[101]);
    expect(items.every((s) => s.revokedAt === null)).toBe(true);
    expect(items.filter((s) => s.current)).toHaveLength(1);
    // The administrator's list of the same user in this org: the same rule.
    const admin = await call(
      as(ADMIN, ORG_A, { roles: ["owner"] }),
      "GET",
      `/v1/users/${USER_D}/sessions`,
    );
    expect(admin.statusCode).toBe(200);
    const theirs = SessionList.schema.parse(JSON.parse(admin.body)).items;
    expect(theirs).toHaveLength(100);
    const theirIds = theirs.map((s) => s.id);
    expect(theirIds).toEqual([...theirIds].sort().reverse());
    expect(theirIds).not.toContain(revoked);
    expect(theirIds).not.toContain(oldest);
    expect(theirs.every((s) => s.revokedAt === null && !s.current)).toBe(true);
  });

  test("closes one of the caller's sessions in another org: audit event and outbox row under the request's org; the closed session is then 401; another user's is 404", async () => {
    const sid = newSid();
    const target = await signIn(as(USER_A, ORG_C, { sid }));
    const before = await counts();
    const res = await call(
      as(USER_A, ORG_A),
      "DELETE",
      `/v1/sessions/${target}`,
    );
    expect(res.statusCode, res.body).toBe(204);
    const audits = (await auditRows("org.session.revoke")).filter(
      (a) => a.entity_id === target,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ org_id: ORG_A, actor_id: USER_A });
    expect(audits[0]?.after).toMatchObject({
      cause: "self",
      sessionId: target,
      sessions: [{ id: target, orgId: ORG_C, userId: USER_A }],
    });
    const outbox = (await outboxRows()).filter(
      (o) => o.payload.sessionId === target,
    );
    expect(outbox).toEqual([
      {
        org_id: ORG_A,
        topic: "sessions.revoked",
        payload: {
          sessionId: target,
          userId: USER_A,
          orgId: ORG_C,
          keycloakSid: sid,
        },
      },
    ]);
    const after = await counts();
    expect([after.audit - before.audit, after.outbox - before.outbox]).toEqual([
      1, 1,
    ]);
    expectProblem(
      await call(as(USER_A, ORG_C, { sid }), "GET", "/v1/sessions"),
      401,
      "session_expired",
    );
    // Again: idempotent, nothing written.
    expect(
      (await call(as(USER_A, ORG_A), "DELETE", `/v1/sessions/${target}`))
        .statusCode,
    ).toBe(204);
    expect(await counts()).toEqual(after);
    // Another user's session, open: 404 and still open.
    const theirs = await signIn(as(USER_B, ORG_A));
    expectProblem(
      await call(as(USER_A, ORG_A), "DELETE", `/v1/sessions/${theirs}`),
      404,
      "not_found",
    );
    expect(
      (await sessionRows(USER_B)).find((s) => s.id === theirs)?.revoked_at,
    ).toBeNull();
    expect(await counts()).toEqual(after);
  });

  test("closing the current session: 204, and the next request on it is 401 session_expired", async () => {
    const sid = newSid();
    const current = await signIn(as(USER_A, ORG_A, { sid }));
    expect(
      (
        await call(
          as(USER_A, ORG_A, { sid }),
          "DELETE",
          `/v1/sessions/${current}`,
        )
      ).statusCode,
    ).toBe(204);
    expectProblem(
      await call(as(USER_A, ORG_A, { sid }), "GET", "/v1/sessions"),
      401,
      "session_expired",
    );
  });
});

describe("administrator routes: /v1/users/:userId/sessions (owner conditions 1 D9 gate and 3)", () => {
  test("with the production grants source (noGrants, until P5-05) every caller is 403, even for their own id", async () => {
    for (const [method, url] of [
      ["GET", `/v1/users/${USER_B}/sessions`],
      ["POST", `/v1/users/${USER_B}/sessions/revoke`],
      ["GET", `/v1/users/${ADMIN}/sessions`],
    ] as const) {
      expectProblem(
        await call(as(ADMIN, ORG_A), method, url, undefined, production),
        403,
        "forbidden",
      );
    }
  });

  test("without org.session.read.org another user's session in the same org is not readable (403); with it the list is this org's rows only", async () => {
    const sid = newSid();
    const inA = await signIn(as(USER_B, ORG_A, { sid }));
    const inB = await signIn(as(USER_B, ORG_B, { sid }));
    const url = `/v1/users/${USER_B}/sessions`;
    expectProblem(
      await call(as(ADMIN, ORG_A, { roles: ["project_manager"] }), "GET", url),
      403,
      "forbidden",
    );
    expectProblem(await call(as(ADMIN, ORG_A), "GET", url), 403, "forbidden");
    for (const role of ["owner", "auditor"]) {
      const res = await call(as(ADMIN, ORG_A, { roles: [role] }), "GET", url);
      expect(res.statusCode, role).toBe(200);
      const { items } = SessionList.schema.parse(JSON.parse(res.body));
      expect(items.map((s) => s.id)).toContain(inA);
      expect(items.map((s) => s.id)).not.toContain(inB);
      expect(
        items.every(
          (s) => s.orgId === ORG_A && s.userId === USER_B && !s.current,
        ),
      ).toBe(true);
    }
    // The grant is org-scoped: the same owner asking in org C sees nothing of org A.
    const elsewhere = await call(
      as(ADMIN, ORG_C, { roles: ["owner"] }),
      "GET",
      url,
    );
    expect(elsewhere.statusCode).toBe(200);
    expect(SessionList.schema.parse(JSON.parse(elsewhere.body)).items).toEqual(
      [],
    );
  });

  test("revoke needs org.session.revoke.org (auditor reads but 403s); the owner closes the user's open sessions in this org only, with audit + outbox; a second call closes nothing and writes nothing", async () => {
    const sid = newSid();
    const inA = await signIn(as(USER_B, ORG_A, { sid }));
    const inB = await signIn(as(USER_B, ORG_B, { sid }));
    const url = `/v1/users/${USER_B}/sessions/revoke`;
    expectProblem(
      await call(as(ADMIN, ORG_A, { roles: ["auditor"] }), "POST", url),
      403,
      "forbidden",
    );
    const before = await counts();
    const res = await call(as(ADMIN, ORG_A, { roles: ["owner"] }), "POST", url);
    expect(res.statusCode, res.body).toBe(200);
    const { revoked } = RevokedSessions.schema.parse(JSON.parse(res.body));
    expect(revoked).toContain(inA);
    expect(revoked).not.toContain(inB);
    const rows = await sessionRows(USER_B);
    expect(rows.find((s) => s.id === inA)?.revoked_at).not.toBeNull();
    expect(rows.find((s) => s.id === inB)?.revoked_at).toBeNull();
    expect(
      rows
        .filter((s) => s.org_id === ORG_A)
        .every((s) => s.revoked_at !== null),
    ).toBe(true);
    const audits = (await auditRows("org.session.revoke")).filter(
      (a) =>
        (a.after as { cause: string; userId?: string }).cause === "admin" &&
        (a.after as { userId?: string }).userId === USER_B,
    );
    const last = audits.at(-1);
    expect(last).toMatchObject({ org_id: ORG_A, actor_id: ADMIN });
    const listed = (
      last?.after as { sessions: { id: string; orgId: string }[] }
    ).sessions;
    expect(listed.map((s) => s.id).sort()).toEqual([...revoked].sort());
    expect(listed.every((s) => s.orgId === ORG_A)).toBe(true);
    const outbox = (await outboxRows()).filter((o) =>
      revoked.includes(String(o.payload.sessionId)),
    );
    expect(outbox).toHaveLength(revoked.length);
    expect(
      outbox.every(
        (o) =>
          o.org_id === ORG_A &&
          o.payload.orgId === ORG_A &&
          o.payload.userId === USER_B,
      ),
    ).toBe(true);
    const after = await counts();
    expect([after.audit - before.audit, after.outbox - before.outbox]).toEqual([
      1,
      revoked.length,
    ]);
    expectProblem(
      await call(as(USER_B, ORG_A, { sid }), "GET", "/v1/sessions"),
      401,
      "session_expired",
    );
    expect(
      (await call(as(USER_B, ORG_B, { sid }), "GET", "/v1/sessions"))
        .statusCode,
    ).toBe(200);
    // Nothing left to close: 200 with [] and no new rows.
    const again = await call(
      as(ADMIN, ORG_A, { roles: ["owner"] }),
      "POST",
      url,
    );
    expect(again.statusCode).toBe(200);
    expect(RevokedSessions.schema.parse(JSON.parse(again.body))).toEqual({
      revoked: [],
    });
    expect(await counts()).toEqual(after);
    // An unknown user: 200 with [] (never a leak), nothing written.
    const nobody = await call(
      as(ADMIN, ORG_A, { roles: ["owner"] }),
      "POST",
      `/v1/users/${NOBODY}/sessions/revoke`,
    );
    expect(nobody.statusCode).toBe(200);
    expect(await counts()).toEqual(after);
  });
});

describe("a revoke is one transaction", () => {
  test("when the outbox insert fails, the session stays open and no audit event is written (500 generic)", async () => {
    const sid = newSid();
    const target = await signIn(as(USER_A, ORG_B, { sid }));
    await asAdmin(`
      CREATE FUNCTION public.refuse_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'outbox refused (test)'; END $$;
      CREATE TRIGGER refuse_outbox BEFORE INSERT ON bricx.outbox
        FOR EACH ROW WHEN (NEW.payload->>'sessionId' = '${target}') EXECUTE FUNCTION public.refuse_outbox();
    `);
    const before = await counts();
    try {
      const res = await call(
        as(USER_A, ORG_A),
        "DELETE",
        `/v1/sessions/${target}`,
      );
      expectProblem(res, 500, "generic");
      expect(
        (await sessionRows(USER_A)).find((s) => s.id === target)?.revoked_at,
      ).toBeNull();
      expect(await counts()).toEqual(before);
    } finally {
      await asAdmin(
        "DROP TRIGGER refuse_outbox ON bricx.outbox; DROP FUNCTION public.refuse_outbox()",
      );
    }
    // Without the fault the same revoke succeeds.
    expect(
      (await call(as(USER_A, ORG_A), "DELETE", `/v1/sessions/${target}`))
        .statusCode,
    ).toBe(204);
  });
});
