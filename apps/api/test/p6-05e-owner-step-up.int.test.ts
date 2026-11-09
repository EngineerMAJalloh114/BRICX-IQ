// P6-05e Done-when (ADR 0081; owner conditions C1, C2), live: the API's
// step-up for org-admin keys against the real realm (started as
// compose.yml starts it), with tokens from real bricx-client browser
// logins (code + PKCE), on compose.yml's Postgres with the production
// journal and the production grants source.
// - An organisation owner whose bricx-mfa mapping has not landed yet (the
//   window ADR 0081 states) signs in at acr pwd: an owner-level action
//   (PATCH /v1/organizations/current, org.organization.update) is 401
//   permission.step_up_required with the RFC 9470 challenge; revoking
//   another user's sessions (org.session.revoke) is 401 too. A read is
//   allowed.
// - C1: at acr pwd the same owner revokes their OWN session and device
//   (DELETE /v1/sessions/:id and /v1/devices/:id, @NoPermission, no key):
//   204 each. A lost device never needs the second factor to cut it off.
// - With bricx-mfa mapped, the owner sets up OTP at the next login, gets
//   acr mfa, and the same actions succeed.
// - A custom role holding only org.member.invite and org.member.read (an
//   "administrator" by key, ADR 0081) is 401 on POST /v1/members at pwd,
//   200 on the list.
// - A site_engineer (no admin key, no finance key) at pwd is unaffected:
//   their reads and self-service answer as before, and an org-admin
//   action they do not hold is 403, never 401 (stepping up would not help).
// Hooks get 600 s (P5-01 condition 1).
import { Writable } from "node:stream";
import { loadApiConfig } from "@bricx/config/api";
import {
  type BootstrappedPostgres,
  appDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { migrate } from "@bricx/db/migrate";
import { isArray, isObject } from "@bricx/keycloak-realm/normalise";
import {
  Browser,
  type Keycloak,
  claimsOf,
  formAction,
  keycloakService,
  pkce,
  startKeycloak,
  tokenCall,
  totp,
  totpSecretOf,
} from "@bricx/keycloak-realm/testing";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";
import {
  applyAccess,
  bearer,
  fixedRevocations,
  seedId,
  seedRole,
  seedUsers,
} from "./support/auth.js";
import { memoryRateLimits } from "./support/rate-limit.js";

const HOOK_MS = 600_000;
const ORG = "01920000-0000-7000-8000-0000000008a1";
const PROJECT = "01920000-0000-7000-8000-0000000008b1";
const DEVICE = "01920000-0000-7000-8000-0000000008d1";
const PASSWORD = "test-only-admin-step-up-pw-1";
const redirect = keycloakService.environment.KEYCLOAK_WEB_REDIRECT_URI ?? "";
const CHALLENGE =
  'Bearer error="insufficient_user_authentication", acr_values="mfa"';

let keycloak: Keycloak | undefined;
let pg18: BootstrappedPostgres | undefined;
let app: NestFastifyApplication | undefined;

function kc(): Keycloak {
  if (keycloak === undefined) throw new Error("Keycloak did not start");
  return keycloak;
}
function api(): NestFastifyApplication {
  if (app === undefined) throw new Error("the API did not start");
  return app;
}

async function asAdmin<R extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  if (pg18 === undefined) throw new Error("Postgres did not start");
  const admin = await pg18.admin();
  try {
    return (await admin.query<R>(text, params)).rows;
  } finally {
    await admin.end();
  }
}

/** A realm user with org_id and no realm role; returns its sub. */
async function createUser(name: string): Promise<string> {
  await kc().admin("POST", "/users", {
    username: name,
    email: `${name}@example.test`,
    firstName: "Test",
    lastName: "User",
    enabled: true,
    emailVerified: true,
    attributes: { org_id: [ORG] },
    credentials: [{ type: "password", value: PASSWORD, temporary: false }],
  });
  const found = await kc().admin("GET", `/users?username=${name}&exact=true`);
  const user = isArray(found) ? found[0] : undefined;
  const id = isObject(user) ? user.id : undefined;
  if (typeof id !== "string") throw new Error(`user ${name} was not created`);
  return id;
}

/** What the worker does when app.mfa_state() says required (ADR 0066). */
async function mapMfa(sub: string): Promise<void> {
  const role = await kc().admin("GET", "/roles/bricx-mfa");
  await kc().admin("POST", `/users/${sub}/role-mappings/realm`, [role]);
}

/** A browser login: password, then OTP setup when the realm asks for it. */
async function signIn(
  name: string,
): Promise<{ token: string; otpConfigured: boolean }> {
  const browser = new Browser(kc().base);
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
  let page = await browser.follow(
    await browser.request(formAction(login), {
      username: name,
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
  if (page.status !== 302 || !page.location.startsWith(redirect)) {
    throw new Error(`login did not reach the app: HTTP ${String(page.status)}`);
  }
  const code = new URL(page.location).searchParams.get("code") ?? "";
  const tokens = await tokenCall(kc(), kc().base, {
    grant_type: "authorization_code",
    client_id: "bricx-client",
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
  });
  return { token: tokens.access_token, otpConfigured: secret !== undefined };
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";
async function call(
  token: string,
  method: Method,
  url: string,
  body?: unknown,
  extra: Record<string, string> = {},
) {
  return api().inject({
    method,
    url,
    headers: {
      ...bearer(token),
      ...extra,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

function expectStepUp(res: {
  statusCode: number;
  headers: Record<string, unknown>;
  json: () => unknown;
}) {
  expect(res.statusCode).toBe(401);
  expect(res.headers["www-authenticate"]).toBe(CHALLENGE);
  expect(res.json()).toMatchObject({
    status: 401,
    code: "permission.step_up_required",
    key: "errors:permission.step_up_required",
  });
}

const subs = { owner: "", inviter: "", engineer: "", other: "" };
const ids = {
  owner: "01920000-0000-7000-8000-0000000008e1",
  inviter: "01920000-0000-7000-8000-0000000008e2",
  engineer: "01920000-0000-7000-8000-0000000008e3",
  other: "01920000-0000-7000-8000-0000000008e4",
} as const;

beforeAll(async () => {
  [keycloak, pg18] = await Promise.all([startKeycloak(), startPostgres()]);
  const pg = pg18;
  const urlFor = (role: string, key: string) =>
    `postgres://${role}:${exampleValue(key)}@${pg.container.getHost()}:${String(pg.container.getMappedPort(5432))}/${appDatabase}`;
  await migrate({
    reveal: () => urlFor("bricx_owner", "BRICX_OWNER_PASSWORD"),
  });
  subs.owner = await createUser("admin-step-up-owner");
  subs.inviter = await createUser("admin-step-up-inviter");
  subs.engineer = await createUser("admin-step-up-engineer");
  subs.other = await createUser("admin-step-up-other");
  await seedUsers(asAdmin, [
    { id: ids.owner, sub: subs.owner },
    { id: ids.inviter, sub: subs.inviter },
    { id: ids.engineer, sub: subs.engineer },
    { id: ids.other, sub: subs.other },
  ]);
  await applyAccess(asAdmin, { orgId: ORG, userId: ids.owner, role: "owner" });
  await applyAccess(asAdmin, {
    orgId: ORG,
    userId: ids.engineer,
    role: "site_engineer",
    projects: [PROJECT],
  });
  await applyAccess(asAdmin, {
    orgId: ORG,
    userId: ids.other,
    role: "site_engineer",
    projects: [PROJECT],
  });
  // A custom role: member invite and read only (an administrator by key).
  const inviterRole = await seedRole(asAdmin, ORG, "inviter");
  for (const permission of ["org.member.invite.org", "org.member.read.org"]) {
    await asAdmin(
      `INSERT INTO bricx.role_permissions (id, org_id, role_id, permission, granted_at)
       VALUES ($1, $2, $3, $4, now() - interval '1 minute')`,
      [seedId(), ORG, inviterRole, permission],
    );
  }
  await applyAccess(asAdmin, {
    orgId: ORG,
    userId: ids.inviter,
    role: "inviter",
  });
  app = await createApp(
    loadApiConfig(
      apiEnv({
        KEYCLOAK_ISSUER: `${keycloak.base}/realms/bricx`,
        DATABASE_URL: urlFor("bricx_app", "BRICX_APP_PASSWORD"),
      }),
    ),
    {
      probes: fakeProbes(),
      revocationStore: fixedRevocations(),
      rateLimitStore: memoryRateLimits(),
      logStream: new Writable({
        write(_chunk: Buffer, _encoding, done) {
          done();
        },
      }),
    },
  );
  await app.init();
}, HOOK_MS);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await keycloak?.container.stop();
  await pg18?.container.stop();
}, HOOK_MS);

describe("an organisation owner at acr pwd (T11, C1)", () => {
  test("owner-level actions are 401 step-up with the RFC 9470 challenge; a read is allowed; their OWN session and device revoke at pwd (204)", async () => {
    // Two logins: the first one's session is revoked from the second.
    const first = await signIn("admin-step-up-owner");
    const { token, otpConfigured } = await signIn("admin-step-up-owner");
    expect(otpConfigured).toBe(false);
    expect(claimsOf(token)).toMatchObject({ sub: subs.owner, acr: "pwd" });

    expectStepUp(
      await call(token, "PATCH", "/v1/organizations/current", {
        legalName: "Step-up Holdings",
      }),
    );
    expectStepUp(
      await call(token, "POST", `/v1/users/${ids.other}/sessions/revoke`),
    );
    expect(
      (await call(token, "GET", "/v1/organizations/current")).statusCode,
    ).toBe(200);

    // C1: self-service needs no second factor.
    const firstSessions = await call(first.token, "GET", "/v1/sessions");
    expect(firstSessions.statusCode).toBe(200);
    const sessions = await call(token, "GET", "/v1/sessions");
    const items = sessions.json<{
      items: { id: string; current: boolean }[];
    }>().items;
    const other = items.find((s) => !s.current);
    if (other === undefined) throw new Error("the first login has no session");
    expect(
      (await call(token, "DELETE", `/v1/sessions/${other.id}`)).statusCode,
    ).toBe(204);
    expect(
      (
        await call(
          token,
          "POST",
          "/v1/devices",
          { id: DEVICE, platform: "android", name: "Lost phone" },
          { "x-device-id": DEVICE },
        )
      ).statusCode,
    ).toBe(201);
    expect(
      (await call(token, "DELETE", `/v1/devices/${DEVICE}`)).statusCode,
    ).toBe(204);
    // The revoked session's token is refused from now on.
    expect((await call(first.token, "GET", "/v1/sessions")).statusCode).toBe(
      401,
    );
  });
});

describe("the same owner after step-up (T12)", () => {
  test("with bricx-mfa mapped: OTP at login, acr mfa, the owner-level actions succeed", async () => {
    await mapMfa(subs.owner);
    const { token, otpConfigured } = await signIn("admin-step-up-owner");
    expect(otpConfigured).toBe(true);
    expect(claimsOf(token)).toMatchObject({ sub: subs.owner, acr: "mfa" });
    const patched = await call(token, "PATCH", "/v1/organizations/current", {
      legalName: "Step-up Holdings",
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({ legalName: "Step-up Holdings" });
    const revoked = await call(
      token,
      "POST",
      `/v1/users/${ids.other}/sessions/revoke`,
    );
    expect(revoked.statusCode, revoked.body).toBe(200);
  });
});

describe("an administrator by key: a custom role with org.member.invite (T14)", () => {
  test("at acr pwd: POST /v1/members is 401 step-up; the member list is 200", async () => {
    const { token } = await signIn("admin-step-up-inviter");
    expect(claimsOf(token)).toMatchObject({ acr: "pwd" });
    expectStepUp(
      await call(
        token,
        "POST",
        "/v1/members",
        { userId: ids.other, roleId: seedId() },
        { "idempotency-key": "01920000-0000-7000-8000-0000000008f1" },
      ),
    );
    expect((await call(token, "GET", "/v1/members")).statusCode).toBe(200);
  });
});

describe("a member with no admin and no finance key (T13)", () => {
  test("a site_engineer at acr pwd: reads and self-service as before; an org-admin action they do not hold is 403, never 401", async () => {
    const { token, otpConfigured } = await signIn("admin-step-up-engineer");
    expect(otpConfigured).toBe(false);
    expect(claimsOf(token)).toMatchObject({ acr: "pwd" });
    expect((await call(token, "GET", "/v1/sessions")).statusCode).toBe(200);
    expect((await call(token, "GET", "/v1/me/memberships")).statusCode).toBe(
      200,
    );
    expect(
      (await call(token, "GET", `/v1/projects/${PROJECT}`)).statusCode,
    ).toBe(200);
    const patch = await call(token, "PATCH", "/v1/organizations/current", {
      legalName: "Not Mine",
    });
    expect(patch.statusCode).toBe(403);
    expect(patch.json()).toMatchObject({ code: "forbidden" });
  });
});
