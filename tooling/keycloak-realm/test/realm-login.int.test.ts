// Live logins against the imported bricx realm (P5-01 architect review,
// ADR 0060), headless: refresh keeps the assurance level a login reached
// (acr, auth_time, session) and rotates the refresh token (review item 2);
// a password reset cannot reach acr mfa without OTP (item 3); WebAuthn
// passwordless registration is an enabled required action while the browser
// flow has no passwordless step (item 1). One Keycloak, started as
// compose.yml starts it, plus host.docker.internal so it can reach this
// process's SMTP sink. Hooks get 600 s (condition 1).
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { isArray, isObject, type Json } from "../src/normalise.js";
import {
  Browser,
  claimsOf,
  formAction,
  type Page,
  pkce,
  type Tokens,
  totp,
  totpSecretOf,
} from "./browser.js";
import { type Keycloak, keycloakService, startKeycloak } from "./keycloak.js";
import { type SmtpSink, startSmtpSink } from "./smtp.js";

const HOOK_MS = 600_000;
const ORG_ID = "01920000-0000-7000-8000-000000000001";
const PASSWORD = "test-only-login-pw-1";
const redirect = keycloakService.environment.KEYCLOAK_WEB_REDIRECT_URI ?? "";

let keycloak: Keycloak | undefined;
let sink: SmtpSink | undefined;

function kc(): Keycloak {
  if (keycloak === undefined) throw new Error("Keycloak did not start");
  return keycloak;
}

beforeAll(async () => {
  sink = await startSmtpSink();
  keycloak = await startKeycloak(undefined, [
    { host: "host.docker.internal", ipAddress: "host-gateway" },
  ]);
  // SMTP is deployment config (P13-01); the file sets none. Test-only.
  await keycloak.admin("PUT", "", {
    smtpServer: {
      host: "host.docker.internal",
      port: String(sink.port),
      from: "keycloak@example.test",
    },
  });
}, HOOK_MS);

afterAll(async () => {
  await keycloak?.container.stop();
  await sink?.close();
}, HOOK_MS);

async function createUser(name: string, mfa: boolean): Promise<string> {
  await kc().admin("POST", "/users", {
    username: name,
    email: `${name}@example.test`,
    firstName: "Test",
    lastName: "User",
    enabled: true,
    emailVerified: true,
    attributes: { org_id: [ORG_ID] },
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

/** Starts the bricx-client code flow; returns the login page. */
async function authorize(
  browser: Browser,
  challenge: string,
  extra: Record<string, string> = {},
): Promise<Page> {
  const query = new URLSearchParams({
    ...extra,
    client_id: "bricx-client",
    redirect_uri: redirect,
    response_type: "code",
    scope: "openid",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state",
    nonce: "nonce",
  });
  const page = await browser.request(
    `/realms/bricx/protocol/openid-connect/auth?${query.toString()}`,
  );
  // A live SSO session may answer with a redirect (to the OTP form or
  // straight back to the app): the caller follows it.
  expect([200, 302]).toContain(page.status);
  return page;
}

/** Exchanges the code in the app redirect for tokens. */
async function exchange(page: Page, verifier: string): Promise<Tokens> {
  expect(page.status).toBe(302);
  expect(page.location.startsWith(redirect)).toBe(true);
  const code = new URL(page.location).searchParams.get("code") ?? "";
  return tokenCall({
    grant_type: "authorization_code",
    client_id: "bricx-client",
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
  });
}

async function tokenCall(form: Record<string, string>): Promise<Tokens> {
  const response = await kc().fetch(
    `${kc().base}/realms/bricx/protocol/openid-connect/token`,
    { method: "POST", body: new URLSearchParams(form) },
  );
  const body: unknown = await response.json();
  if (
    !response.ok ||
    typeof body !== "object" ||
    body === null ||
    !("access_token" in body) ||
    !("refresh_token" in body) ||
    typeof body.access_token !== "string" ||
    typeof body.refresh_token !== "string"
  ) {
    throw new Error(`token call failed: HTTP ${String(response.status)}`);
  }
  return { access_token: body.access_token, refresh_token: body.refresh_token };
}

/** A browser login: password, then OTP setup when the flow asks for it. */
async function signIn(
  name: string,
): Promise<{ tokens: Tokens; otpConfigured: boolean }> {
  const browser = new Browser(kc().base);
  const { verifier, challenge } = pkce();
  const login = await authorize(browser, challenge);
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
  return {
    tokens: await exchange(page, verifier),
    otpConfigured: secret !== undefined,
  };
}

async function refreshResponse(
  refreshToken: string,
): Promise<{ status: number; error: unknown }> {
  const response = await kc().fetch(
    `${kc().base}/realms/bricx/protocol/openid-connect/token`,
    {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "bricx-client",
        refresh_token: refreshToken,
      }),
    },
  );
  const body: unknown = await response.json();
  const error =
    typeof body === "object" && body !== null && "error" in body
      ? body.error
      : undefined;
  return { status: response.status, error };
}

/** One refresh: same acr, auth_time and session, and a rotated token. */
async function expectRefreshKeepsAssurance(
  tokens: Tokens,
  acr: string,
): Promise<void> {
  const before = claimsOf(tokens.access_token);
  expect(before.acr).toBe(acr);
  const after = await tokenCall({
    grant_type: "refresh_token",
    client_id: "bricx-client",
    refresh_token: tokens.refresh_token,
  });
  const claims = claimsOf(after.access_token);
  expect(claims.acr).toBe(acr);
  expect(claims.auth_time).toBe(before.auth_time);
  expect(claims.sid).toBe(before.sid);
  expect(after.refresh_token).not.toBe(tokens.refresh_token);
  // Rotation: the old refresh token is spent.
  expect(await refreshResponse(tokens.refresh_token)).toEqual({
    status: 400,
    error: "invalid_grant",
  });
}

describe("refresh keeps the assurance a login reached (review item 2)", () => {
  test("bricx-mfa user: OTP at login, acr mfa, same auth_time and session after a refresh, refresh token rotated", async () => {
    await createUser("refresh-mfa", true);
    const { tokens, otpConfigured } = await signIn("refresh-mfa");
    expect(otpConfigured).toBe(true);
    await expectRefreshKeepsAssurance(tokens, "mfa");
  });

  test("password-only user: acr pwd stays pwd after a refresh", async () => {
    await createUser("refresh-pwd", false);
    const { tokens, otpConfigured } = await signIn("refresh-pwd");
    expect(otpConfigured).toBe(false);
    await expectRefreshKeepsAssurance(tokens, "pwd");
  });
});

describe("password reset (review item 3)", () => {
  test("a reset-credentials login of a bricx-mfa user without OTP gets acr pwd, never mfa, and sets up no OTP", async () => {
    const id = await createUser("reset-mfa", true);
    const browser = new Browser(kc().base);
    const { verifier, challenge } = pkce();
    const login = await authorize(browser, challenge);
    const link = /href="([^"]*login-actions\/reset-credentials[^"]*)"/.exec(
      login.body,
    )?.[1];
    expect(link).toBeDefined();
    const reset = await browser.request((link ?? "").replaceAll("&amp;", "&"));
    const sent = sink?.messages.length ?? 0;
    const asked = await browser.request(formAction(reset), {
      username: "reset-mfa",
    });
    expect(asked.status).toBe(200);
    const mail = await waitForMessage(sent);
    const url = /(https?:\/\/[^\s"<>]*action-token[^\s"<>]*)/.exec(
      mail.replaceAll("=\n", "").replaceAll("=3D", "="),
    )?.[1];
    expect(url).toBeDefined();
    const update = await browser.follow(
      await browser.request((url ?? "").replaceAll("&amp;", "&")),
    );
    expect(update.body).toContain('name="password-new"');
    const done = await browser.follow(
      await browser.request(formAction(update), {
        "password-new": "test-only-login-pw-2",
        "password-confirm": "test-only-login-pw-2",
      }),
    );
    const tokens = await exchange(done, verifier);
    expect(claimsOf(tokens.access_token).acr).toBe("pwd");
    const refreshed = await tokenCall({
      grant_type: "refresh_token",
      client_id: "bricx-client",
      refresh_token: tokens.refresh_token,
    });
    expect(claimsOf(refreshed.access_token).acr).toBe("pwd");
    const credentials = await kc().admin("GET", `/users/${id}/credentials`);
    const types = isArray(credentials)
      ? credentials.map((c) => (isObject(c) ? c.type : null))
      : [];
    // No OTP. P6-05e (ADR 0081): passwordHistory(5) keeps the reset's
    // previous password as a password-history credential.
    expect(types.sort()).toEqual(["password", "password-history"]);
  });
});

async function waitForMessage(already: number): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const message = sink?.messages[already];
    if (message !== undefined) return message;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Keycloak sent no reset e-mail");
}

describe("WebAuthn passwordless (review item 1)", () => {
  test("registration is an enabled, non-default required action; the browser flows have no passwordless step", async () => {
    const actions = await kc().admin("GET", "/authentication/required-actions");
    const enabled = isArray(actions)
      ? actions
          .filter((a) => isObject(a) && a.enabled === true)
          .map((a) => (isObject(a) ? a.alias : null))
          .sort()
      : [];
    expect(enabled).toEqual(
      [
        "CONFIGURE_TOTP",
        "UPDATE_PASSWORD",
        "UPDATE_PROFILE",
        "VERIFY_EMAIL",
        "VERIFY_PROFILE",
        "webauthn-register-passwordless",
      ].sort(),
    );
    const passwordless = isArray(actions)
      ? actions.find(
          (a) => isObject(a) && a.alias === "webauthn-register-passwordless",
        )
      : undefined;
    expect(passwordless).toMatchObject({ enabled: true, defaultAction: false });
    for (const alias of ["bricx browser", "bricx forms", "bricx mfa"]) {
      const executions: Json = await kc().admin(
        "GET",
        `/authentication/flows/${encodeURIComponent(alias)}/executions`,
      );
      const providers = isArray(executions)
        ? executions.map((e) => (isObject(e) ? e.providerId : null))
        : [];
      expect(providers, alias).not.toContain(
        "webauthn-authenticator-passwordless",
      );
    }
  });
});

// P6-06c (ADR 0085, owner condition C4): the first red test of the task.
// Ownership transfer needs a FRESH authentication (auth_time within 300 s).
// The API reads auth_time; this proves Keycloak moves it when the user
// authenticates again. Owner ruling 2026-11-12 (Q4): the client re-logs in
// with prompt=login&acr_values=mfa&max_age=300; if that does not advance
// auth_time the task stops and the realm change goes to the owner.
describe("re-authentication advances auth_time (P6-06c, C4)", () => {
  const FRESH = { prompt: "login", acr_values: "mfa", max_age: "300" };
  let lastWindow = -1;

  /** A TOTP code from a 30 s window no earlier code used (no reuse). */
  async function freshOtp(secret: string): Promise<string> {
    for (;;) {
      const window = Math.floor(Date.now() / 30_000);
      if (window > lastWindow) {
        lastWindow = window;
        return totp(secret, Date.now());
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  /** Fills whatever Keycloak shows (password, OTP form, OTP setup) until the app redirect. */
  async function complete(
    browser: Browser,
    first: Page,
    name: string,
    otp: { secret?: string; steps?: string[] },
  ): Promise<Page> {
    otp.steps = [];
    let page = await browser.follow(first);
    for (let step = 0; step < 5 && page.status === 200; step += 1) {
      if (page.body.includes('name="password"')) {
        otp.steps.push("password");
        page = await browser.follow(
          await browser.request(formAction(page), {
            username: name,
            password: PASSWORD,
            credentialId: "",
          }),
        );
        continue;
      }
      const setup = totpSecretOf(page);
      if (setup !== undefined) {
        otp.secret = setup;
        otp.steps.push("otp-setup");
        lastWindow = Math.floor(Date.now() / 30_000);
        page = await browser.follow(
          await browser.request(formAction(page), {
            totp: totp(setup, Date.now()),
            totpSecret: setup,
            userLabel: "test",
            mode: "",
          }),
        );
        continue;
      }
      if (page.body.includes('name="otp"') && otp.secret !== undefined) {
        otp.steps.push("otp");
        page = await browser.follow(
          await browser.request(formAction(page), {
            otp: await freshOtp(otp.secret),
          }),
        );
        continue;
      }
      throw new Error(`unexpected login page (step ${String(step)})`);
    }
    return page;
  }

  async function login(
    browser: Browser,
    name: string,
    otp: { secret?: string; steps?: string[] },
    extra: Record<string, string> = {},
  ): Promise<Record<string, unknown> & { tokens: Tokens }> {
    const { verifier, challenge } = pkce();
    const page = await complete(
      browser,
      await authorize(browser, challenge, extra),
      name,
      otp,
    );
    const tokens = await exchange(page, verifier);
    return { ...claimsOf(tokens.access_token), tokens };
  }

  const pause = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  test("bricx-mfa user: prompt=login&acr_values=mfa&max_age=300 asks password and OTP again and moves auth_time forward; a refresh keeps the new auth_time", async () => {
    await createUser("fresh-login", true);
    const browser = new Browser(kc().base);
    const otp: { secret?: string; steps?: string[] } = {};
    const first = await login(browser, "fresh-login", otp);
    expect(first.acr).toBe("mfa");
    expect(Number.isInteger(first.auth_time)).toBe(true);
    await pause(2_100);
    const again = await login(browser, "fresh-login", otp, FRESH);
    expect(otp.steps).toEqual(["password", "otp"]);
    expect(again.acr).toBe("mfa");
    expect(again.sid).toBe(first.sid);
    expect(Number(again.auth_time)).toBeGreaterThan(Number(first.auth_time));
    await expectRefreshKeepsAssurance(again.tokens, "mfa");
  }, 180_000);

  test("bricx-mfa user: an OTP-only step-up (acr_values=mfa, same SSO session) asks OTP again; auth_time moves forward", async () => {
    await createUser("fresh-stepup", true);
    const browser = new Browser(kc().base);
    const otp: { secret?: string; steps?: string[] } = {};
    const first = await login(browser, "fresh-stepup", otp);
    await pause(2_100);
    const stepped = await login(browser, "fresh-stepup", otp, {
      acr_values: "mfa",
    });
    expect(otp.steps).toEqual(["otp"]);
    expect(stepped.acr).toBe("mfa");
    expect(stepped.sid).toBe(first.sid);
    // Observed on the first run (Keycloak 26, 2026-11-12): the OTP-only
    // step-up also moves auth_time. Pinned so an upgrade that changes it
    // is noticed; the client still uses prompt=login (owner ruling Q4).
    expect(Number(stepped.auth_time)).toBeGreaterThan(Number(first.auth_time));
  }, 180_000);

  test("a recipient without OTP: after bricx-mfa is mapped, the prompt=login re-login makes them set up OTP and reaches acr mfa with a new auth_time", async () => {
    const id = await createUser("fresh-enrol", false);
    const browser = new Browser(kc().base);
    const otp: { secret?: string; steps?: string[] } = {};
    const first = await login(browser, "fresh-enrol", otp);
    expect(first.acr).toBe("pwd");
    expect(otp.secret).toBeUndefined();
    const role = await kc().admin("GET", "/roles/bricx-mfa");
    await kc().admin("POST", `/users/${id}/role-mappings/realm`, [role]);
    await pause(2_100);
    const again = await login(browser, "fresh-enrol", otp, FRESH);
    expect(otp.steps).toEqual(["password", "otp-setup"]);
    expect(otp.secret).toBeDefined();
    expect(again.acr).toBe("mfa");
    expect(Number(again.auth_time)).toBeGreaterThan(Number(first.auth_time));
  }, 180_000);
});
