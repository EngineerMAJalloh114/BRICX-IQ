// The bricx realm file's security settings (P5-01, ADR 0060), read from the
// committed JSON. realm-import.int.test.ts proves Keycloak holds the same
// values after importing it.
import { describe, expect, test } from "vitest";
import { isArray, isObject, text, type Json } from "../src/normalise.js";
import {
  loadRealm,
  PLACEHOLDERS,
  placeholderNames,
  userProfileOf,
} from "../src/realm.js";

type Obj = { readonly [key: string]: Json };
const realm = loadRealm();

function obj(value: Json | undefined, what: string): Obj {
  if (!isObject(value)) throw new Error(`${what} is not an object`);
  return value;
}
function list(value: Json | undefined, what: string): readonly Json[] {
  if (!isArray(value)) throw new Error(`${what} is not an array`);
  return value;
}
function named(items: Json | undefined, key: string, value: string): Obj {
  const found = list(items, key).filter(
    (item) => isObject(item) && item[key] === value,
  );
  if (found.length !== 1) throw new Error(`no single ${key} ${value}`);
  return obj(found[0], value);
}
const client = (id: string) => named(realm.clients, "clientId", id);
const flow = (alias: string) =>
  named(realm.authenticationFlows, "alias", alias);
const config = (alias: string) =>
  obj(named(realm.authenticatorConfig, "alias", alias).config, alias);
const scope = (name: string) => named(realm.clientScopes, "name", name);
const mapper = (scopeName: string, name: string) =>
  named(scope(scopeName).protocolMappers, "name", name);
const executions = (alias: string) =>
  list(flow(alias).authenticationExecutions, alias).map((e) =>
    obj(e, `${alias} execution`),
  );

describe("1. the realm", () => {
  test("is bricx, enabled, TLS required outside private networks", () => {
    expect(realm.realm).toBe("bricx");
    expect(realm.enabled).toBe(true);
    expect(realm.sslRequired).toBe("external");
  });

  test("has no users, no self-registration and no organisations feature", () => {
    expect(realm.users).toBeUndefined();
    expect(realm.registrationAllowed).toBe(false);
    expect(realm.organizationsEnabled).toBe(false);
  });

  test("carries no secret or credential value anywhere", () => {
    // Field names under which Keycloak's representations carry secrets.
    const SECRET_KEYS = new Set([
      "secret",
      "password",
      "credentials",
      "privateKey",
      "certificate",
      "secretData",
      "users",
    ]);
    const keys: string[] = [];
    const visit = (value: Json, key: string): void => {
      if (SECRET_KEYS.has(key)) keys.push(key);
      if (isArray(value)) {
        for (const item of value) visit(item, key);
      } else if (isObject(value)) {
        for (const [k, v] of Object.entries(value)) visit(v, k);
      }
    };
    visit(realm, "$");
    expect(keys).toEqual([]);
  });

  test("reads only the three web placeholders from the environment", () => {
    // The lower-case names are Keycloak's own message keys in the user
    // profile (display names); no such variable is set, so the import
    // leaves them literal (realm-import.int.test.ts reads them back).
    expect(placeholderNames(realm)).toEqual(
      [...PLACEHOLDERS, "email", "firstName", "lastName", "username"].sort(),
    );
  });

  test("names localhost nowhere (the web URI is a dev-only .env value)", () => {
    expect(JSON.stringify(realm)).not.toMatch(/localhost|127\.0\.0\.1/);
  });
});

describe("2. bricx-client", () => {
  const app = () => client("bricx-client");
  const attributes = () => obj(app().attributes, "bricx-client attributes");

  test("is public with the authorization code flow only", () => {
    expect(app().publicClient).toBe(true);
    expect(app().bearerOnly).toBe(false);
    expect(app().standardFlowEnabled).toBe(true);
    expect(app().implicitFlowEnabled).toBe(false);
    expect(app().directAccessGrantsEnabled).toBe(false);
    expect(app().serviceAccountsEnabled).toBe(false);
    expect(attributes()["oauth2.device.authorization.grant.enabled"]).toBe(
      "false",
    );
    expect(attributes()["oidc.ciba.grant.enabled"]).toBe("false");
    expect(attributes()["standard.token.exchange.enabled"]).toBe("false");
  });

  test("requires PKCE with S256", () => {
    expect(attributes()["pkce.code.challenge.method"]).toBe("S256");
  });

  test("has exact redirect and logout URIs: the app scheme and the web placeholders", () => {
    expect(app().redirectUris).toEqual([
      "com.bricxiq.app://auth/callback",
      "${KEYCLOAK_WEB_REDIRECT_URI}",
    ]);
    expect(app().webOrigins).toEqual(["${KEYCLOAK_WEB_ORIGIN}"]);
    // Keycloak separates post-logout redirect URIs with "##".
    expect(attributes()["post.logout.redirect.uris"]).toBe(
      "com.bricxiq.app://auth/logout##${KEYCLOAK_WEB_LOGOUT_URI}",
    );
    const uris = [
      ...list(app().redirectUris, "redirectUris"),
      ...list(app().webOrigins, "webOrigins"),
      ...text(
        attributes()["post.logout.redirect.uris"],
        "post.logout.redirect.uris",
      ).split("##"),
    ];
    for (const uri of uris)
      expect(text(uri, "a redirect URI")).not.toContain("*");
  });

  test("gets only BRICX scopes: no roles, no offline_access, full scope off", () => {
    expect([...list(app().defaultClientScopes, "default")].sort()).toEqual([
      "acr",
      "basic",
      "bricx-api-audience",
      "bricx-org",
      "bricx-profile",
      "web-origins",
    ]);
    expect(app().optionalClientScopes).toEqual([]);
    expect(app().fullScopeAllowed).toBe(false);
  });
});

describe("3. bricx-api", () => {
  const api = () => client("bricx-api");

  test("is bearer-only with every grant off", () => {
    expect(api().bearerOnly).toBe(true);
    expect(api().publicClient).toBe(false);
    expect(api().standardFlowEnabled).toBe(false);
    expect(api().implicitFlowEnabled).toBe(false);
    expect(api().directAccessGrantsEnabled).toBe(false);
    expect(api().serviceAccountsEnabled).toBe(false);
    const attributes = obj(api().attributes, "bricx-api attributes");
    expect(attributes["oauth2.device.authorization.grant.enabled"]).toBe(
      "false",
    );
    expect(attributes["oidc.ciba.grant.enabled"]).toBe("false");
    expect(attributes["standard.token.exchange.enabled"]).toBe("false");
  });

  test("is the audience of bricx-client's access tokens", () => {
    const audience = obj(
      mapper("bricx-api-audience", "bricx-api audience").config,
      "audience",
    );
    expect(
      mapper("bricx-api-audience", "bricx-api audience").protocolMapper,
    ).toBe("oidc-audience-mapper");
    expect(audience["included.client.audience"]).toBe("bricx-api");
    expect(audience["access.token.claim"]).toBe("true");
    expect(audience["id.token.claim"]).toBe("false");
  });
});

describe("4. tokens and sessions", () => {
  test("access tokens live 5 minutes", () => {
    expect(realm.accessTokenLifespan).toBe(300);
  });

  test("refresh tokens rotate: each one is usable once", () => {
    expect(realm.revokeRefreshToken).toBe(true);
    expect(realm.refreshTokenMaxReuse).toBe(0);
  });

  test("sessions end after 12 h idle (an org can only shorten it)", () => {
    expect(realm.ssoSessionIdleTimeout).toBe(43_200);
    expect(realm.offlineSessionIdleTimeout).toBe(43_200);
    expect(realm.clientSessionIdleTimeout).toBe(0);
  });

  test("personal data is in the ID token only, never the access token", () => {
    for (const m of list(scope("bricx-profile").protocolMappers, "profile")) {
      const c = obj(obj(m, "mapper").config, "mapper config");
      expect(c["access.token.claim"]).toBe("false");
      expect(c["id.token.claim"]).toBe("true");
    }
  });
});

describe("5. MFA for bricx-mfa users (condition 4)", () => {
  test("the browser flow is bricx browser: cookie, else bricx forms", () => {
    expect(realm.browserFlow).toBe("bricx browser");
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

  test("bricx forms: password at level pwd, then the conditional MFA subflow", () => {
    expect(
      executions("bricx forms").map((e) => [e.flowAlias, e.requirement]),
    ).toEqual([
      ["bricx pwd", "CONDITIONAL"],
      ["bricx mfa", "CONDITIONAL"],
    ]);
    expect(
      executions("bricx pwd").map((e) => [e.authenticator, e.requirement]),
    ).toEqual([
      ["conditional-level-of-authentication", "REQUIRED"],
      ["auth-username-password-form", "REQUIRED"],
    ]);
  });

  test("bricx mfa runs only for the bricx-mfa role and requires OTP at level mfa", () => {
    const mfa = executions("bricx mfa");
    expect(mfa.map((e) => [e.authenticator, e.requirement])).toEqual([
      ["conditional-user-role", "REQUIRED"],
      ["conditional-level-of-authentication", "REQUIRED"],
      ["auth-otp-form", "REQUIRED"],
    ]);
    expect(
      config(text(mfa[0]?.authenticatorConfig, "role condition config")),
    ).toEqual({
      condUserRole: "bricx-mfa",
      negate: "false",
    });
    expect(
      config(text(mfa[1]?.authenticatorConfig, "LoA condition config"))[
        "loa-condition-level"
      ],
    ).toBe("2");
  });

  test("acr names the levels: pwd = 1, mfa = 2; bricx-client asks for mfa", () => {
    const attributes = obj(realm.attributes, "realm attributes");
    expect(JSON.parse(text(attributes["acr.loa.map"], "acr.loa.map"))).toEqual({
      pwd: 1,
      mfa: 2,
    });
    expect(
      obj(client("bricx-client").attributes, "attributes")[
        "default.acr.values"
      ],
    ).toBe("mfa");
  });

  test("the acr mapper puts the achieved level in access and ID tokens", () => {
    const acr = mapper("acr", "acr loa level");
    expect(acr.protocolMapper).toBe("oidc-acr-mapper");
    const c = obj(acr.config, "acr config");
    expect(c["access.token.claim"]).toBe("true");
    expect(c["id.token.claim"]).toBe("true");
  });

  test("bricx-mfa is a realm role no client scope maps into tokens", () => {
    const roles = list(obj(realm.roles, "roles").realm, "realm roles");
    expect(roles.map((r) => obj(r, "role").name)).toEqual(["bricx-mfa"]);
    expect(realm.clientScopes).not.toContainEqual(
      expect.objectContaining({ name: "roles" }),
    );
  });
});

describe("6. WebAuthn passwordless: policy and registration only, no sign-in step yet (P7-05)", () => {
  test("the passwordless policy requires user verification and a resident key", () => {
    expect(realm.webAuthnPolicyPasswordlessUserVerificationRequirement).toBe(
      "required",
    );
    expect(realm.webAuthnPolicyPasswordlessResidentKey).toBe("Required");
    expect(realm.webAuthnPolicyPasswordlessRpEntityName).toBe("BRICX IQ");
  });

  test("required actions are exactly the six BRICX uses, passwordless registration among them, none a default action", () => {
    // A file that lists requiredActions replaces Keycloak's defaults, so
    // this is the whole set: OTP setup (bricx-mfa), password update (reset),
    // profile and e-mail checks, passkey registration.
    const actions = list(realm.requiredActions, "requiredActions").map((a) =>
      obj(a, "required action"),
    );
    expect(actions.map((a) => [a.alias, a.providerId, a.enabled])).toEqual([
      ["CONFIGURE_TOTP", "CONFIGURE_TOTP", true],
      ["UPDATE_PASSWORD", "UPDATE_PASSWORD", true],
      ["UPDATE_PROFILE", "UPDATE_PROFILE", true],
      ["VERIFY_EMAIL", "VERIFY_EMAIL", true],
      [
        "webauthn-register-passwordless",
        "webauthn-register-passwordless",
        true,
      ],
      ["VERIFY_PROFILE", "VERIFY_PROFILE", true],
    ]);
    expect(actions.every((a) => a.defaultAction === false)).toBe(true);
  });

  test("no browser flow has a passwordless step: a registered passkey cannot sign in yet", () => {
    const authenticators = list(
      realm.authenticationFlows,
      "authenticationFlows",
    ).flatMap((f) =>
      list(obj(f, "flow").authenticationExecutions, "executions").map(
        (e) => obj(e, "execution").authenticator,
      ),
    );
    expect(authenticators).not.toContain("webauthn-authenticator-passwordless");
  });
});

describe("7. brute-force detection", () => {
  test("5 failures, 60 s increments, 15 min max wait, no permanent lockout", () => {
    expect(realm.bruteForceProtected).toBe(true);
    expect(realm.failureFactor).toBe(5);
    expect(realm.waitIncrementSeconds).toBe(60);
    expect(realm.maxFailureWaitSeconds).toBe(900);
    expect(realm.permanentLockout).toBe(false);
  });
});

describe("8. org_id (condition 3: a default-org hint)", () => {
  const profile = () => obj(userProfileOf(realm), "user profile");
  const orgId = () => named(profile().attributes, "name", "org_id");

  test("only admins can view or edit it; unmanaged attributes are off", () => {
    expect(orgId().permissions).toEqual({ view: ["admin"], edit: ["admin"] });
    expect(profile().unmanagedAttributePolicy).toBeUndefined();
  });

  test("it must be a UUIDv7", () => {
    const pattern = obj(obj(orgId().validations, "validations").pattern, "p");
    const uuidV7 =
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(pattern.pattern).toBe(uuidV7.source);
    expect(uuidV7.test("01920000-0000-7000-8000-000000000001")).toBe(true);
    expect(uuidV7.test("01920000-0000-4000-8000-000000000001")).toBe(false);
  });

  test("it reaches the access token only, as org_id", () => {
    const c = obj(mapper("bricx-org", "org_id").config, "org_id mapper");
    expect(c["user.attribute"]).toBe("org_id");
    expect(c["claim.name"]).toBe("org_id");
    expect(c["access.token.claim"]).toBe("true");
    expect(c["id.token.claim"]).toBe("false");
    expect(c.multivalued).toBe("false");
  });
});

describe("9. events", () => {
  test("login failures are recorded for 7 days, nothing else", () => {
    expect(realm.eventsEnabled).toBe(true);
    expect(realm.eventsExpiration).toBe(604_800);
    expect(realm.enabledEventTypes).toEqual([
      "LOGIN_ERROR",
      "CODE_TO_TOKEN_ERROR",
      "REFRESH_TOKEN_ERROR",
      "CLIENT_LOGIN_ERROR",
    ]);
    expect(realm.adminEventsEnabled).toBe(false);
  });
});
