// The bricx realm is reproducible from its file (P5-01 Done-when, ADR 0060):
// two fresh Keycloaks, started as compose.yml starts them, import
// infrastructure/keycloak/realm-bricx.json; every value the file sets is
// what each one holds, and both hold the identical realm. Then the live
// server refuses what the file forbids: PKCE-less and implicit logins,
// unknown redirect URIs, and every grant type on bricx-api (condition 5).
// Keycloak is built and booted once per container (optimized image,
// condition 1); hooks get 600 s.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  isArray,
  isObject,
  type Json,
  normalise,
  subsetProblems,
  text,
} from "../src/normalise.js";
import {
  loadRealm,
  PLACEHOLDERS,
  realmFile,
  resolvePlaceholders,
  userProfileOf,
  withoutComponents,
} from "../src/realm.js";
import {
  composeRealmMount,
  exportRealm,
  type Keycloak,
  keycloakService,
  startKeycloak,
} from "./keycloak.js";

const HOOK_MS = 600_000;
const file = loadRealm();
const env = Object.fromEntries(
  PLACEHOLDERS.map((name) => [name, keycloakService.environment[name] ?? ""]),
);
const expectedRealm = resolvePlaceholders(withoutComponents(file), env);
const expectedProfile = resolvePlaceholders(userProfileOf(file), env);

let first: Keycloak;
let second: Keycloak | undefined;
let firstExport: Json;
let firstProfile: Json;

beforeAll(async () => {
  first = await startKeycloak();
  firstExport = await exportRealm(first);
  firstProfile = await first.admin("GET", "/users/profile");
}, HOOK_MS);

afterAll(async () => {
  await first.container.stop();
  await second?.container.stop();
}, HOOK_MS);

type Obj = { readonly [key: string]: Json };
function pick(items: Json | undefined, key: string, value: string): Obj {
  const found = isArray(items)
    ? items.filter((item) => isObject(item) && item[key] === value)
    : [];
  const one = found[0];
  if (found.length !== 1 || !isObject(one)) {
    throw new Error(`no single ${key} ${value}`);
  }
  return one;
}

describe("compose.yml starts the optimized image with the realm file", () => {
  test("start --optimized --import-realm, the file mounted read-only", () => {
    expect(keycloakService.command).toEqual([
      "start",
      "--optimized",
      "--import-realm",
      "--http-enabled=true",
      "--hostname-strict=false",
    ]);
    expect(composeRealmMount.source).toBe(realmFile);
    expect(composeRealmMount.target).toBe(
      "/opt/keycloak/data/import/realm-bricx.json",
    );
    expect(composeRealmMount.read_only).toBe(true);
    for (const name of PLACEHOLDERS) expect(env[name]).not.toBe("");
  });
});

describe("the realm is reproducible from the file", () => {
  test("every value the file sets is the value Keycloak holds", () => {
    expect(subsetProblems(expectedRealm, firstExport)).toEqual([]);
  });

  test("the declarative user profile is the file's", () => {
    expect(subsetProblems(expectedProfile, firstProfile)).toEqual([]);
    expect(
      isObject(firstProfile) && firstProfile.unmanagedAttributePolicy,
    ).toBeFalsy();
  });

  test(
    "a second fresh Keycloak imports the identical realm",
    async () => {
      const fresh = await startKeycloak();
      second = fresh;
      const secondExport = await exportRealm(fresh);
      const secondProfile = await fresh.admin("GET", "/users/profile");
      expect(normalise(secondExport)).toEqual(normalise(firstExport));
      expect(normalise(secondProfile)).toEqual(normalise(firstProfile));
    },
    HOOK_MS,
  );

  test("the realm has no users and the placeholder realm is gone", async () => {
    expect(await first.admin("GET", "/users?max=1")).toEqual([]);
    const placeholder = await first.fetch(
      `${first.base}/realms/bricx-placeholder/.well-known/openid-configuration`,
    );
    expect(placeholder.status).toBe(404);
  });
});

describe("the imported MFA flow (condition 4)", () => {
  const flows = () => (isObject(firstExport) ? firstExport : {});
  const executions = (alias: string) => {
    const list = pick(
      flows().authenticationFlows,
      "alias",
      alias,
    ).authenticationExecutions;
    return isArray(list) ? list.filter(isObject) : [];
  };
  const configOf = (alias: string) =>
    pick(flows().authenticatorConfig, "alias", alias).config;

  test("bricx browser is the browser flow: cookie, else bricx forms", () => {
    expect(flows().browserFlow).toBe("bricx browser");
    expect(
      executions("bricx browser").map((e) => [
        e.authenticator ?? e.flowAlias,
        e.requirement,
      ]),
    ).toEqual([
      ["auth-cookie", "ALTERNATIVE"],
      ["bricx forms", "ALTERNATIVE"],
    ]);
  });

  test("the OTP subflow is conditional, keyed on role bricx-mfa, at level mfa", () => {
    expect(
      executions("bricx forms").map((e) => [e.flowAlias, e.requirement]),
    ).toEqual([
      ["bricx pwd", "CONDITIONAL"],
      ["bricx mfa", "CONDITIONAL"],
    ]);
    const mfa = executions("bricx mfa");
    expect(mfa.map((e) => [e.authenticator, e.requirement])).toEqual([
      ["conditional-user-role", "REQUIRED"],
      ["conditional-level-of-authentication", "REQUIRED"],
      ["auth-otp-form", "REQUIRED"],
    ]);
    expect(
      configOf(text(mfa[0]?.authenticatorConfig, "role condition config")),
    ).toEqual({
      condUserRole: "bricx-mfa",
      negate: "false",
    });
    expect(
      configOf(text(mfa[1]?.authenticatorConfig, "LoA condition config")),
    ).toMatchObject({
      "loa-condition-level": "2",
    });
  });

  test("the acr mapper is in bricx-client's default scopes, mfa = level 2", async () => {
    const acr = pick(flows().clientScopes, "name", "acr");
    expect(pick(acr.protocolMappers, "name", "acr loa level")).toMatchObject({
      protocolMapper: "oidc-acr-mapper",
      config: { "access.token.claim": "true", "id.token.claim": "true" },
    });
    const app = pick(flows().clients, "clientId", "bricx-client");
    expect(app.defaultClientScopes).toContain("acr");
    const realm = await first.admin("GET", "");
    const attributes = isObject(realm) ? realm.attributes : undefined;
    expect(
      JSON.parse(
        text(
          isObject(attributes) ? attributes["acr.loa.map"] : undefined,
          "acr.loa.map",
        ),
      ),
    ).toEqual({ pwd: 1, mfa: 2 });
  });
});

describe("the live server", () => {
  const oidc = () => `${first.base}/realms/bricx/protocol/openid-connect`;
  const redirect = () => env.KEYCLOAK_WEB_REDIRECT_URI ?? "";
  const challenge = "a".repeat(43);

  async function authorize(params: Record<string, string>) {
    const response = await first.fetch(
      `${oidc()}/auth?${new URLSearchParams({ scope: "openid", ...params }).toString()}`,
    );
    return {
      status: response.status,
      location: response.headers.get("location") ?? "",
      page: await response.text(),
    };
  }

  async function token(params: Record<string, string>, path = "/token") {
    const response = await first.fetch(`${oidc()}${path}`, {
      method: "POST",
      body: new URLSearchParams(params),
    });
    const body = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body };
  }

  async function apiSecret(): Promise<string> {
    const clients = await first.admin("GET", "/clients?clientId=bricx-api");
    const id = text(
      isArray(clients) && isObject(clients[0]) ? clients[0].id : undefined,
      "the bricx-api client id",
    );
    const secret = await first.admin("GET", `/clients/${id}/client-secret`);
    const value = isObject(secret) ? secret.value : undefined;
    if (typeof value !== "string" || value === "") {
      throw new Error("bricx-api has no secret to prove refusals with");
    }
    return value;
  }

  let probeUser = false;
  /** A real user, so a refused password grant is not a wrong password. */
  async function ensureProbeUser(): Promise<void> {
    if (probeUser) return;
    await first.admin("POST", "/users", {
      username: "grant-probe",
      email: "grant-probe@example.test",
      firstName: "Grant",
      lastName: "Probe",
      enabled: true,
      emailVerified: true,
      credentials: [
        { type: "password", value: "test-only-probe-pw", temporary: false },
      ],
    });
    probeUser = true;
  }

  test("the issuer is /realms/bricx and S256 is offered", async () => {
    const response = await first.fetch(
      `${first.base}/realms/bricx/.well-known/openid-configuration`,
    );
    const discovery = (await response.json()) as Record<string, unknown>;
    expect(discovery.issuer).toBe(`${first.base}/realms/bricx`);
    expect(discovery.code_challenge_methods_supported).toContain("S256");
  });

  test("bricx-client: a login without PKCE, or with plain PKCE, is refused", async () => {
    const base = {
      client_id: "bricx-client",
      response_type: "code",
      redirect_uri: redirect(),
    };
    const none = await authorize(base);
    expect(none.status).toBe(302);
    expect(none.location).toContain("error=invalid_request");
    expect(none.location).toContain("code_challenge_method");
    const plain = await authorize({
      ...base,
      code_challenge: challenge,
      code_challenge_method: "plain",
    });
    expect(plain.location).toContain("error=invalid_request");
    const s256 = await authorize({
      ...base,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    expect(s256.status).toBe(200);
    expect(s256.page).toContain("kc-form-login");
  });

  test("bricx-client: implicit login and unknown redirect URIs are refused", async () => {
    const implicit = await authorize({
      client_id: "bricx-client",
      response_type: "token",
      redirect_uri: redirect(),
      nonce: "n",
    });
    expect(implicit.location).toContain("error=unauthorized_client");
    const evil = await authorize({
      client_id: "bricx-client",
      response_type: "code",
      redirect_uri: "https://evil.example/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    expect(evil.status).toBe(400);
    expect(evil.page).not.toContain("kc-form-login");
  });

  test("bricx-client: password, client-credentials and device grants are refused", async () => {
    await ensureProbeUser();
    const password = await token({
      client_id: "bricx-client",
      grant_type: "password",
      username: "grant-probe",
      password: "test-only-probe-pw",
    });
    expect(password.body.error).toBe("unauthorized_client");
    const credentials = await token({
      client_id: "bricx-client",
      grant_type: "client_credentials",
    });
    expect(credentials.body.error).toBe("unauthorized_client");
    const device = await token({ client_id: "bricx-client" }, "/auth/device");
    expect(device.body.error).toBe("unauthorized_client");
    for (const result of [password, credentials, device]) {
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(result.body).not.toHaveProperty("access_token");
    }
  });

  test("bricx-api refuses every grant type, with its real secret", async () => {
    await ensureProbeUser();
    const client = { client_id: "bricx-api", client_secret: await apiSecret() };
    const grants: Record<string, string>[] = [
      {
        grant_type: "password",
        username: "grant-probe",
        password: "test-only-probe-pw",
      },
      { grant_type: "client_credentials" },
      { grant_type: "refresh_token", refresh_token: "not-a-token" },
      {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: "not-a-token",
        subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      },
      {
        grant_type: "authorization_code",
        code: "not-a-code",
        redirect_uri: redirect(),
      },
    ];
    for (const grant of grants) {
      const result = await token({ ...client, ...grant });
      expect(result.status, grant.grant_type).toBeGreaterThanOrEqual(400);
      expect(result.body.error, grant.grant_type).toBe("invalid_client");
      expect(result.body.error_description, grant.grant_type).toBe(
        "Bearer-only not allowed",
      );
    }
    const device = await token(client, "/auth/device");
    expect(device.body.error).toBe("unauthorized_client");
    const ciba = await token(
      { ...client, scope: "openid", login_hint: "grant-probe" },
      "/ext/ciba/auth",
    );
    expect(ciba.body.error).toBe("invalid_client");
    for (const responseType of ["code", "token"]) {
      const login = await authorize({
        client_id: "bricx-api",
        response_type: responseType,
        redirect_uri: redirect(),
        nonce: "n",
      });
      expect(login.status, responseType).toBe(403);
      expect(login.page).toContain("Bearer-only applications are not allowed");
    }
  });
});
