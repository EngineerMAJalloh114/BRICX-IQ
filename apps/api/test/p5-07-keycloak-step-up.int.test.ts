// P5-07 Done when DW4, live (ADR 0068; owner decision D-F as changed,
// conditions 1 and 4): the API's step-up against the real P5-01 realm,
// started as compose.yml starts it (@bricx/keycloak-realm/testing), with
// tokens from real bricx-client browser logins (code + PKCE). The API runs
// on compose.yml's Postgres with the production journal and the production
// grants source; both users hold finance.payment.approve on the project
// through a project_owner membership.
// - A bricx-mfa user sets up OTP at the login, gets acr mfa, and the
//   finance route (test-only fixture, test/support) is allowed.
// - A password-only user with the same grant gets acr pwd and is refused
//   with 401 permission.step_up_required and the RFC 9470 challenge, never
//   403; a non-finance route is allowed at pwd.
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
  seedUsers,
} from "./support/auth.js";
import { FinanceFixtureController } from "./support/finance-fixture.js";

const HOOK_MS = 600_000;
const ORG = "01920000-0000-7000-8000-0000000007a1";
const PROJECT = "01920000-0000-7000-8000-0000000007b1";
const PAYMENT = "01920000-0000-7000-8000-0000000007c1";
const PASSWORD = "test-only-step-up-pw-1";
const redirect = keycloakService.environment.KEYCLOAK_WEB_REDIRECT_URI ?? "";
const APPROVE = `/v1/test-finance/projects/${PROJECT}/payments/${PAYMENT}/approve`;
const MILESTONES = `/v1/test-finance/projects/${PROJECT}/milestones`;

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

/** A realm user with org_id, bricx-mfa when `mfa`; returns its sub. */
async function createUser(name: string, mfa: boolean): Promise<string> {
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
  if (mfa) {
    const role = await kc().admin("GET", "/roles/bricx-mfa");
    await kc().admin("POST", `/users/${id}/role-mappings/realm`, [role]);
  }
  return id;
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

const subs = { mfa: "", pwd: "" };
const ids = {
  mfa: "01920000-0000-7000-8000-0000000007e1",
  pwd: "01920000-0000-7000-8000-0000000007e2",
} as const;

beforeAll(async () => {
  [keycloak, pg18] = await Promise.all([startKeycloak(), startPostgres()]);
  const pg = pg18;
  const urlFor = (role: string, key: string) =>
    `postgres://${role}:${exampleValue(key)}@${pg.container.getHost()}:${String(pg.container.getMappedPort(5432))}/${appDatabase}`;
  await migrate({
    reveal: () => urlFor("bricx_owner", "BRICX_OWNER_PASSWORD"),
  });
  subs.mfa = await createUser("step-up-mfa", true);
  subs.pwd = await createUser("step-up-pwd", false);
  await seedUsers(asAdmin, [
    { id: ids.mfa, sub: subs.mfa },
    { id: ids.pwd, sub: subs.pwd },
  ]);
  for (const userId of Object.values(ids)) {
    await applyAccess(asAdmin, {
      orgId: ORG,
      userId,
      role: "project_owner",
      projects: [PROJECT],
    });
  }
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
      logStream: new Writable({
        write(_chunk: Buffer, _encoding, done) {
          done();
        },
      }),
      extraControllers: [FinanceFixtureController],
    },
  );
  await app.init();
}, HOOK_MS);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await keycloak?.container.stop();
  await pg18?.container.stop();
}, HOOK_MS);

describe("DW4: step-up with the real realm", () => {
  test("a bricx-mfa user: OTP at login, acr mfa, the finance route is allowed", async () => {
    const { token, otpConfigured } = await signIn("step-up-mfa");
    expect(otpConfigured).toBe(true);
    expect(claimsOf(token)).toMatchObject({ sub: subs.mfa, acr: "mfa" });
    const res = await api().inject({
      method: "POST",
      url: APPROVE,
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      approved: true,
      userId: ids.mfa,
      acr: "mfa",
    });
  });

  test("a password-only user with the same finance grant: acr pwd, 401 step-up with the RFC 9470 challenge, never 403; a non-finance route is allowed", async () => {
    const { token, otpConfigured } = await signIn("step-up-pwd");
    expect(otpConfigured).toBe(false);
    expect(claimsOf(token)).toMatchObject({ sub: subs.pwd, acr: "pwd" });
    const res = await api().inject({
      method: "POST",
      url: APPROVE,
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBe(
      'Bearer error="insufficient_user_authentication", acr_values="mfa"',
    );
    expect(res.json()).toMatchObject({
      status: 401,
      code: "permission.step_up_required",
      key: "errors:permission.step_up_required",
    });
    const read = await api().inject({
      method: "GET",
      url: MILESTONES,
      headers: bearer(token),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ userId: ids.pwd, acr: "pwd" });
  });
});
