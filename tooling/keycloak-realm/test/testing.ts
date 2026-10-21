// `@bricx/keycloak-realm/testing` (P5-02, plan decision 7): the live
// Keycloak helpers for other packages' integration suites. apps/api's
// token tests start the real realm with startKeycloak() and get real
// tokens with passwordLogin() (bricx-client, code + PKCE, a password-only
// user). A dev dependency of apps/api only; src never imports it (Semgrep
// bricx-src-imports-test-support).
import { isArray, isObject } from "../src/normalise.js";
import { Browser, formAction, pkce, type Tokens } from "./browser.js";
import { type Keycloak, keycloakService } from "./keycloak.js";

export {
  Browser,
  claimsOf,
  formAction,
  pkce,
  type Page,
  type Tokens,
  totp,
  totpSecretOf,
} from "./browser.js";
export { type Keycloak, keycloakService, startKeycloak } from "./keycloak.js";

const redirect = keycloakService.environment.KEYCLOAK_WEB_REDIRECT_URI ?? "";

export interface RealmUser {
  readonly username: string;
  readonly password: string;
  /** The org_id attribute; undefined leaves it unset. */
  readonly orgId?: string | undefined;
}

/** Creates a password-only user in the bricx realm; returns its Keycloak id (the token's sub). */
export async function createRealmUser(
  keycloak: Keycloak,
  user: RealmUser,
): Promise<string> {
  await keycloak.admin("POST", "/users", {
    username: user.username,
    email: `${user.username}@example.test`,
    firstName: "Test",
    lastName: "User",
    enabled: true,
    emailVerified: true,
    attributes: user.orgId === undefined ? {} : { org_id: [user.orgId] },
    credentials: [{ type: "password", value: user.password, temporary: false }],
  });
  const found = await keycloak.admin(
    "GET",
    `/users?username=${encodeURIComponent(user.username)}&exact=true`,
  );
  const created = isArray(found) ? found[0] : undefined;
  const id = isObject(created) ? created.id : undefined;
  if (typeof id !== "string") {
    throw new Error(`user ${user.username} was not created`);
  }
  return id;
}

/**
 * A browser login to bricx-client (code + PKCE) as a password-only user,
 * through `base` (Keycloak's public URL by default; the issuer in the
 * tokens follows the host used, as compose.yml's --hostname-strict=false
 * allows).
 */
export async function passwordLogin(
  keycloak: Keycloak,
  user: RealmUser,
  base = keycloak.base,
): Promise<Tokens> {
  const browser = new Browser(base);
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
  if (login.status !== 200) {
    throw new Error(`login page: HTTP ${String(login.status)}`);
  }
  const done = await browser.follow(
    await browser.request(formAction(login), {
      username: user.username,
      password: user.password,
      credentialId: "",
    }),
  );
  if (done.status !== 302 || !done.location.startsWith(redirect)) {
    throw new Error(`login did not reach the app: HTTP ${String(done.status)}`);
  }
  const code = new URL(done.location).searchParams.get("code") ?? "";
  return tokenCall(keycloak, base, {
    grant_type: "authorization_code",
    client_id: "bricx-client",
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
  });
}

/** A token endpoint call through `base`; throws unless both tokens come back. */
export async function tokenCall(
  keycloak: Keycloak,
  base: string,
  form: Record<string, string>,
): Promise<Tokens> {
  const response = await keycloak.fetch(
    `${base}/realms/bricx/protocol/openid-connect/token`,
    { method: "POST", body: new URLSearchParams(form) },
  );
  const body: unknown = await response.json();
  if (
    !response.ok ||
    typeof body !== "object" ||
    body === null ||
    !("access_token" in body) ||
    typeof body.access_token !== "string"
  ) {
    throw new Error(`token call failed: HTTP ${String(response.status)}`);
  }
  const refresh =
    "refresh_token" in body && typeof body.refresh_token === "string"
      ? body.refresh_token
      : "";
  return { access_token: body.access_token, refresh_token: refresh };
}
