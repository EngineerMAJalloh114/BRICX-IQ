// The Keycloak side of the worker (P5-04, ADR 0065; P5-05, ADR 0066; plan
// decision 5, owner conditions 2 and 3): the admin REST API as the realm's
// bricx-worker service account (ADR 0060: client credentials only,
// realm-management manage-users). The token is requested once at boot
// (the worker refuses to start without it) and again whenever it is about
// to expire; the service account has no refresh token, so the client's
// own refresh path is never used. Two uses:
// - endSession(sid): a revoke ends the user's Keycloak session; one it no
//   longer holds (404) is already ended: the job is idempotent.
// - ensureRealmRole(sub, required): the MFA consumer maps the realm role
//   bricx-mfa onto the user (P5-05 plan 4.2, D-G): added when required and
//   absent, removed when not required and present, nothing when already
//   right; a subject the realm no longer knows is user_missing (the job
//   completes). The role's id comes from the user's own mapping lists
//   (mapped, else available), which manage-users may read; GET /roles/
//   {name} needs view-realm, which the service account does not hold
//   (ADR 0060 condition 2), so the plan's per-boot lookup by name is not
//   used (for architect review).
// - ensureInvitedAccount(email, lifespan) (P6-06, ADR 0077, D6; owner
//   condition C2: the service account also holds view-users, for the exact
//   e-mail lookup): an invitation's activation. No account with that
//   address: one is created (username and e-mail the normalised address,
//   enabled, e-mail NOT verified, required actions VERIFY_EMAIL and
//   UPDATE_PASSWORD) and Keycloak e-mails those actions (execute-actions
//   e-mail, a link valid for `lifespan` seconds). An unverified account:
//   its pending actions are e-mailed again (VERIFY_EMAIL at least). A
//   verified account: nothing (the person signs in). A disabled account:
//   nothing (logged by the consumer). Keycloak's own SMTP sends that
//   e-mail: the realm has none until P13-01 (ADR 0077 launch blocker), so
//   until then the job fails and retries. Two accounts with one address
//   (the realm forbids it) throw.
// Every request carries a timeout (REQUEST_TIMEOUT_MS, the client's own
// AbortSignal): a Keycloak that accepts the connection and never answers
// fails the attempt, which BullMQ retries, instead of holding the job
// (for architect review). Errors leave this module as they come from the
// client (a NetworkError carries the response) and are logged by the
// consumers as a status code only, never as a message: a message can
// carry the host.
import type { WorkerConfig } from "@bricx/config/worker";
import KcAdminClient from "@keycloak/keycloak-admin-client";

/** The realm role the browser flow keys OTP on (infrastructure/keycloak/realm-bricx.json, ADR 0060). */
export const MFA_ROLE = "bricx-mfa";

/** How long one admin request may take before the attempt fails (for architect review). */
export const REQUEST_TIMEOUT_MS = 30_000;

/** The admin client's base URL and realm name, from the realm's issuer. */
export function issuerParts(issuer: string): {
  readonly baseUrl: string;
  readonly realm: string;
} {
  const url = new URL(issuer);
  const found = /^(.*)\/realms\/([^/]+)\/?$/.exec(url.pathname);
  if (found?.[2] === undefined || found[1] === undefined) {
    throw new RangeError("the issuer does not name a realm");
  }
  return { baseUrl: `${url.origin}${found[1]}`, realm: found[2] };
}

export interface SessionEnder {
  /** Requests the service account's token unless the current one is valid. */
  ensureToken(): Promise<void>;
  /** Ends the Keycloak session `sid`; resolves when it is gone (or was). */
  endSession(sid: string): Promise<void>;
}

export type RoleMappingOutcome =
  "added" | "removed" | "unchanged" | "user_missing";

export interface RoleMapper {
  /** Maps or clears MFA_ROLE on the user `sub` so it matches `required`. */
  ensureRealmRole(sub: string, required: boolean): Promise<RoleMappingOutcome>;
}

/** The required actions a new invited account's e-mail asks for. */
export const NEW_ACCOUNT_ACTIONS: readonly string[] = Object.freeze([
  "VERIFY_EMAIL",
  "UPDATE_PASSWORD",
]);
/** The actions an activation may e-mail (anything else is never asked). */
const SENDABLE_ACTIONS: ReadonlySet<string> = new Set(NEW_ACCOUNT_ACTIONS);

export type AccountOutcome =
  "created" | "actions_sent" | "verified" | "disabled";

export interface AccountProvisioner {
  /** Makes sure an account for `email` exists and can be activated (D6). */
  ensureInvitedAccount(
    email: string,
    lifespanSeconds: number,
  ): Promise<AccountOutcome>;
}

export type KeycloakAdmin = SessionEnder & RoleMapper & AccountProvisioner;

/** A user as the admin API lists it (every field may be absent). */
export interface ListedUser {
  readonly id?: string | undefined;
  readonly email?: string | undefined;
  readonly emailVerified?: boolean | undefined;
  readonly enabled?: boolean | undefined;
  readonly requiredActions?: readonly string[] | undefined;
}

/** The admin calls an activation takes (the admin client in production, fakes in tests). */
export interface AccountApi {
  /** Users whose e-mail is exactly `email` (view-users). */
  findByEmail(email: string): Promise<readonly ListedUser[]>;
  /** Creates the account; answers its id. */
  create(email: string, actions: readonly string[]): Promise<string>;
  /** E-mails `actions` to the user (Keycloak's SMTP). */
  sendActions(
    id: string,
    actions: readonly string[],
    lifespanSeconds: number,
  ): Promise<void>;
}

/** The activation over `api`; `before` (the token check) runs first. */
export function accountProvisionerOver(
  api: AccountApi,
  before: () => Promise<void> = () => Promise.resolve(),
): AccountProvisioner {
  return {
    async ensureInvitedAccount(email, lifespanSeconds) {
      await before();
      const found = (await api.findByEmail(email)).filter(
        (user) => user.email?.toLowerCase() === email,
      );
      if (found.length > 1) throw new Error("two accounts share an e-mail");
      const [user] = found;
      if (user === undefined) {
        const id = await api.create(email, NEW_ACCOUNT_ACTIONS);
        await api.sendActions(id, NEW_ACCOUNT_ACTIONS, lifespanSeconds);
        return "created";
      }
      if (user.id === undefined) throw new Error("listed user without an id");
      if (user.enabled === false) return "disabled";
      if (user.emailVerified === true) return "verified";
      const pending = (user.requiredActions ?? []).filter((a) =>
        SENDABLE_ACTIONS.has(a),
      );
      const actions = pending.includes("VERIFY_EMAIL")
        ? pending
        : ["VERIFY_EMAIL", ...pending];
      await api.sendActions(user.id, actions, lifespanSeconds);
      return "actions_sent";
    },
  };
}

/** A realm role as the mapper needs it. */
export interface RealmRole {
  readonly id: string;
  readonly name: string;
}

/** A realm role as the admin API lists it (id and name may be absent in the representation). */
export interface ListedRole {
  readonly id?: string | undefined;
  readonly name?: string | undefined;
}

/** The admin calls a role mapping takes (the admin client in production, fakes in tests). */
export interface RealmRoleApi {
  /** The realm roles mapped to user `sub`, or undefined when the realm has no such user. */
  listUserRoles(sub: string): Promise<readonly ListedRole[] | undefined>;
  /** The realm roles the caller may still map to user `sub`. */
  listAvailableRoles(sub: string): Promise<readonly ListedRole[]>;
  addUserRole(sub: string, role: RealmRole): Promise<void>;
  removeUserRole(sub: string, role: RealmRole): Promise<void>;
}

const mfaRoleIn = (roles: readonly ListedRole[]): RealmRole | undefined => {
  const found = roles.find((role) => role.name === MFA_ROLE);
  return found?.id === undefined ? undefined : { id: found.id, name: MFA_ROLE };
};

/**
 * The mapping over `api`: `before` (the token check) runs before each
 * call. A realm whose available roles lack bricx-mfa throws (retried,
 * then alerted; the realm import is the fix).
 */
export function roleMapperOver(
  api: RealmRoleApi,
  before: () => Promise<void> = () => Promise.resolve(),
): RoleMapper {
  return {
    async ensureRealmRole(sub, required) {
      await before();
      const mapped = await api.listUserRoles(sub);
      if (mapped === undefined) return "user_missing";
      const present = mfaRoleIn(mapped);
      if (required && present === undefined) {
        const target = mfaRoleIn(await api.listAvailableRoles(sub));
        if (target === undefined) {
          throw new Error(`realm role ${MFA_ROLE} missing`);
        }
        await api.addUserRole(sub, target);
        return "added";
      }
      if (!required && present !== undefined) {
        await api.removeUserRole(sub, present);
        return "removed";
      }
      return "unchanged";
    },
  };
}

/** The client types a catchNotFound answer as the resource; at runtime it is null. */
const nullable = <T>(value: T): T | null => value;

export interface KeycloakAdminOptions {
  /** Overrides REQUEST_TIMEOUT_MS (the live tests shorten it). */
  readonly requestTimeoutMs?: number | undefined;
}

export function createKeycloakSessionEnder(
  keycloak: WorkerConfig["keycloak"],
  options: KeycloakAdminOptions = {},
): KeycloakAdmin {
  const { baseUrl, realm } = issuerParts(keycloak.issuer);
  const client = new KcAdminClient({ baseUrl, realmName: realm });
  client.timeout = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const ensureToken = async () => {
    if (client.accessToken !== undefined && !client.isTokenExpired()) return;
    await client.auth({
      grantType: "client_credentials",
      clientId: keycloak.workerClientId,
      clientSecret: keycloak.workerClientSecret.reveal(),
    });
  };
  const api: RealmRoleApi = {
    listAvailableRoles: (sub) =>
      client.users.listAvailableRealmRoleMappings({ realm, id: sub }),
    async listUserRoles(sub) {
      // catchNotFound answers null (untyped) for a user the realm does not know.
      const mapped = nullable(
        await client.users.listRealmRoleMappings(
          { realm, id: sub },
          { catchNotFound: true },
        ),
      );
      return mapped ?? undefined;
    },
    async addUserRole(sub, role) {
      await client.users.addRealmRoleMappings({
        realm,
        id: sub,
        roles: [{ id: role.id, name: role.name }],
      });
    },
    async removeUserRole(sub, role) {
      await client.users.delRealmRoleMappings({
        realm,
        id: sub,
        roles: [{ id: role.id, name: role.name }],
      });
    },
  };
  const accounts: AccountApi = {
    findByEmail: (email) => client.users.find({ realm, email, exact: true }),
    async create(email, actions) {
      const created = await client.users.create({
        realm,
        username: email,
        email,
        enabled: true,
        emailVerified: false,
        requiredActions: [...actions],
      });
      return created.id;
    },
    async sendActions(id, actions, lifespan) {
      await client.users.executeActionsEmail({
        realm,
        id,
        actions: [...actions],
        lifespan,
      });
    },
  };
  return {
    ensureToken,
    ...accountProvisionerOver(accounts, ensureToken),
    async endSession(sid) {
      await ensureToken();
      await client.realms.deleteSession(
        { realm, session: sid, isOffline: false },
        { catchNotFound: true },
      );
    },
    ...roleMapperOver(api, ensureToken),
  };
}
