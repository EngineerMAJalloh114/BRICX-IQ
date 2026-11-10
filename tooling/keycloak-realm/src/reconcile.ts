// `pnpm keycloak:reconcile [--check] [--allow-remote]` (P6-05e, ADR 0081;
// owner condition C5): how a running realm receives the realm file's
// managed settings. Keycloak imports the file only into an empty realm
// (IGNORE_EXISTING, ADR 0060), so a change to these settings reaches an
// existing realm only through the admin API:
// - read-modify-write: GET the whole realm representation, set the managed
//   fields and the one managed attribute inside the existing attributes
//   map (never a partial map), PUT the whole representation back, GET it
//   again and fail unless it now matches;
// - --check changes nothing and exits 1 on drift (the drift check P13-01's
//   deploy runs before applying);
// - only a local Keycloak unless --allow-remote;
// - output and errors name fields, never values.
// - P6-06 (ADR 0077, owner condition C2): the service account's client
//   roles too. The file's one service-account user (bricx-worker) holds a
//   set of realm-management roles, and the client's scope mapping lists
//   the same set; both are managed as exact sets (a missing role is added,
//   an extra one removed: least privilege), each by the admin API's
//   role-mapping endpoints, never by the realm PUT. Drift is named
//   `serviceAccount.<client>` and `scopeMappings.<client>`.
// The managed list is closed: anything else in the file still needs a
// fresh realm locally (`pnpm dev:reset`) or the P13-01 step.
import { isArray, isObject, type Json } from "./normalise.js";

export const MANAGED_FIELDS = [
  "passwordPolicy",
  "adminEventsEnabled",
  "adminEventsDetailsEnabled",
] as const;
export const MANAGED_ATTRIBUTES = ["adminEventsExpiration"] as const;

type Field = (typeof MANAGED_FIELDS)[number];
type Attribute = (typeof MANAGED_ATTRIBUTES)[number];
type JsonObject = { readonly [key: string]: Json };

/** A service account's client roles: the set its user holds and its client's scope maps. */
export interface ServiceAccountRoles {
  /** The confidential client whose service account it is (bricx-worker). */
  readonly client: string;
  /** The client the roles belong to (realm-management). */
  readonly roleClient: string;
  /** The roles, sorted, no duplicates. */
  readonly roles: readonly string[];
}

export interface Desired {
  readonly fields: Readonly<Record<Field, string | boolean>>;
  readonly attributes: Readonly<Record<Attribute, string>>;
  readonly serviceAccount: ServiceAccountRoles;
}

/** Where a service account's roles live: on its user, or in its client's scope. */
export const ROLE_SETS = ["serviceAccount", "scopeMappings"] as const;
export type RoleSet = (typeof ROLE_SETS)[number];

export type ReconcileErrorCode =
  | "remote_refused"
  | "bad_issuer"
  | "bad_realm_file"
  | "bad_realm"
  | "http_error"
  | "still_drifting";

/** An error whose message is its code (plus an HTTP status): no value, no URL. */
export class ReconcileError extends Error {
  readonly code: ReconcileErrorCode;

  constructor(code: ReconcileErrorCode, status?: number) {
    super(
      status === undefined
        ? `keycloak:reconcile: ${code}`
        : `keycloak:reconcile: ${code} (HTTP ${String(status)})`,
    );
    this.code = code;
  }
}
Object.defineProperty(ReconcileError.prototype, "name", {
  value: "ReconcileError",
});

/** The managed settings the realm file sets; every one must be present. */
export function desiredSettings(file: JsonObject): Desired {
  const fields: Partial<Record<Field, string | boolean>> = {};
  for (const name of MANAGED_FIELDS) {
    const value = file[name];
    if (typeof value !== "string" && typeof value !== "boolean") {
      throw new ReconcileError("bad_realm_file");
    }
    fields[name] = value;
  }
  const fileAttributes = file.attributes;
  const attributes: Partial<Record<Attribute, string>> = {};
  for (const name of MANAGED_ATTRIBUTES) {
    const value = isObject(fileAttributes) ? fileAttributes[name] : undefined;
    if (typeof value !== "string") throw new ReconcileError("bad_realm_file");
    attributes[name] = value;
  }
  return {
    fields: fields as Record<Field, string | boolean>,
    attributes: attributes as Record<Attribute, string>,
    serviceAccount: serviceAccountOf(file),
  };
}

const sortedNames = (value: Json | undefined): string[] => {
  if (!isArray(value)) throw new ReconcileError("bad_realm_file");
  const names = value.map((name) => {
    if (typeof name !== "string" || name === "") {
      throw new ReconcileError("bad_realm_file");
    }
    return name;
  });
  const sorted = [...new Set(names)].sort();
  if (sorted.length !== names.length || sorted.length === 0) {
    throw new ReconcileError("bad_realm_file");
  }
  return sorted;
};

/**
 * The file's one service account: its user's client roles (one role
 * client) and the scope mapping of the same client, which must list the
 * same roles (a file where they differ is refused).
 */
function serviceAccountOf(file: JsonObject): ServiceAccountRoles {
  const users = isArray(file.users) ? file.users : [];
  const accounts = users.filter(
    (u): u is JsonObject =>
      isObject(u) && typeof u.serviceAccountClientId === "string",
  );
  const [account] = accounts;
  if (account === undefined || accounts.length !== 1) {
    throw new ReconcileError("bad_realm_file");
  }
  const client = account.serviceAccountClientId;
  const clientRoles = account.clientRoles;
  if (typeof client !== "string" || !isObject(clientRoles)) {
    throw new ReconcileError("bad_realm_file");
  }
  const roleClients = Object.keys(clientRoles);
  const [roleClient] = roleClients;
  if (roleClient === undefined || roleClients.length !== 1) {
    throw new ReconcileError("bad_realm_file");
  }
  const roles = sortedNames(clientRoles[roleClient]);
  const mappings = isObject(file.clientScopeMappings)
    ? file.clientScopeMappings[roleClient]
    : undefined;
  const scoped = (isArray(mappings) ? mappings : []).filter(
    (m): m is JsonObject => isObject(m) && m.client === client,
  );
  const [scope] = scoped;
  if (
    scope === undefined ||
    scoped.length !== 1 ||
    sortedNames(scope.roles).join("\n") !== roles.join("\n")
  ) {
    throw new ReconcileError("bad_realm_file");
  }
  return { client, roleClient, roles };
}

const LOCAL_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

/**
 * The admin API base and realm name of an issuer URL
 * (`<origin>/realms/<name>`). A non-local host needs `allowRemote`.
 */
export function targetOf(
  issuer: string,
  allowRemote: boolean,
): { base: string; realm: string } {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new ReconcileError("bad_issuer");
  }
  const match = /^\/realms\/([A-Za-z0-9_-]{1,64})\/?$/.exec(url.pathname);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    match?.[1] === undefined ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new ReconcileError(
      url.username !== "" || url.password !== ""
        ? "remote_refused"
        : "bad_issuer",
    );
  }
  if (!allowRemote && !LOCAL_HOSTS.has(url.hostname)) {
    throw new ReconcileError("remote_refused");
  }
  return { base: url.origin, realm: match[1] };
}

/** The managed settings that differ, by name (`attributes.<name>` for one attribute). */
export function driftOf(live: Json, desired: Desired): string[] {
  if (!isObject(live)) throw new ReconcileError("bad_realm");
  const drift: string[] = [];
  for (const name of MANAGED_FIELDS) {
    // An unset policy reads back absent; an unset boolean as false.
    const value =
      live[name] ?? (typeof desired.fields[name] === "boolean" ? false : "");
    if (value !== desired.fields[name]) drift.push(name);
  }
  const attributes = isObject(live.attributes) ? live.attributes : {};
  for (const name of MANAGED_ATTRIBUTES) {
    if (attributes[name] !== desired.attributes[name]) {
      drift.push(`attributes.${name}`);
    }
  }
  return drift;
}

/** The whole representation with only the managed settings changed (a new object). */
export function withDesired(live: Json, desired: Desired): JsonObject {
  if (!isObject(live)) throw new ReconcileError("bad_realm");
  const attributes = isObject(live.attributes) ? live.attributes : {};
  return {
    ...live,
    ...desired.fields,
    attributes: { ...attributes, ...desired.attributes },
  };
}

/**
 * The admin API of one realm: its representation, read and written whole,
 * and a service account's client roles, read and changed by name.
 */
export interface RealmAdmin {
  get(): Promise<Json>;
  put(body: Json): Promise<void>;
  /** The roles of `account.roleClient` in `set`, sorted. */
  roles(set: RoleSet, account: ServiceAccountRoles): Promise<string[]>;
  /** Maps `add` and unmaps `remove` (names of `account.roleClient` roles). */
  changeRoles(
    set: RoleSet,
    account: ServiceAccountRoles,
    add: readonly string[],
    remove: readonly string[],
  ): Promise<void>;
}

/** The roles to add and remove for `live` to equal `wanted`. */
export function roleChanges(
  live: readonly string[],
  wanted: readonly string[],
): { add: string[]; remove: string[] } {
  return {
    add: wanted.filter((name) => !live.includes(name)),
    remove: live.filter((name) => !wanted.includes(name)),
  };
}

const roleDriftName = (set: RoleSet, account: ServiceAccountRoles): string =>
  `${set}.${account.client}`;

/** The role sets that differ from the file, by name. */
async function roleDrift(
  admin: RealmAdmin,
  desired: Desired,
): Promise<{ set: RoleSet; add: string[]; remove: string[] }[]> {
  const drift: { set: RoleSet; add: string[]; remove: string[] }[] = [];
  for (const set of ROLE_SETS) {
    const live = await admin.roles(set, desired.serviceAccount);
    const change = roleChanges(live, desired.serviceAccount.roles);
    if (change.add.length > 0 || change.remove.length > 0) {
      drift.push({ set, ...change });
    }
  }
  return drift;
}

/** Applies (or, with "check", only reports) the managed settings. */
export async function reconcile(
  admin: RealmAdmin,
  desired: Desired,
  mode: "apply" | "check",
): Promise<{ drift: string[]; applied: string[] }> {
  const live = await admin.get();
  const realmDrift = driftOf(live, desired);
  const roles = await roleDrift(admin, desired);
  const drift = [
    ...realmDrift,
    ...roles.map((r) => roleDriftName(r.set, desired.serviceAccount)),
  ];
  if (mode === "check" || drift.length === 0) return { drift, applied: [] };
  if (realmDrift.length > 0) await admin.put(withDesired(live, desired));
  for (const change of roles) {
    await admin.changeRoles(
      change.set,
      desired.serviceAccount,
      change.add,
      change.remove,
    );
  }
  if (
    driftOf(await admin.get(), desired).length > 0 ||
    (await roleDrift(admin, desired)).length > 0
  ) {
    throw new ReconcileError("still_drifting");
  }
  return { drift, applied: drift };
}

/** The lines the CLI prints: field names only. */
export function report(
  result: { drift: readonly string[]; applied: readonly string[] },
  mode: "apply" | "check",
): string[] {
  if (result.drift.length === 0) return ["keycloak:reconcile: in sync"];
  return mode === "apply"
    ? result.applied.map((name) => `keycloak:reconcile: applied ${name}`)
    : result.drift.map((name) => `keycloak:reconcile: drift ${name}`);
}

/** A RealmAdmin over fetch with a bearer token from `token()`. */
export function realmAdmin(
  target: { base: string; realm: string },
  token: () => Promise<string>,
  fetchImpl: typeof fetch = fetch,
): RealmAdmin {
  const url = `${target.base}/admin/realms/${target.realm}`;
  const call = async (
    method: string,
    body?: Json,
    suffix = "",
  ): Promise<Response> => {
    const init: RequestInit = {
      method,
      redirect: "manual",
      headers: {
        authorization: `Bearer ${await token()}`,
        "content-type": "application/json",
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetchImpl(`${url}${suffix}`, init);
    if (!response.ok) {
      throw new ReconcileError("http_error", response.status);
    }
    return response;
  };
  const read = async (suffix: string): Promise<Json> => {
    const response = await call("GET", undefined, suffix);
    return (await response.json()) as Json;
  };
  const idOf = (value: Json): string => {
    const found = isArray(value) ? value[0] : value;
    const id = isObject(found) ? found.id : undefined;
    if (typeof id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(id)) {
      throw new ReconcileError("bad_realm");
    }
    return id;
  };
  const clientId = async (name: string): Promise<string> =>
    idOf(await read(`/clients?clientId=${encodeURIComponent(name)}`));
  /** The role-mapping path of `set`, below the realm. */
  const mappingPath = async (
    set: RoleSet,
    account: ServiceAccountRoles,
  ): Promise<string> => {
    const client = await clientId(account.client);
    const roleClient = await clientId(account.roleClient);
    if (set === "scopeMappings") {
      return `/clients/${client}/scope-mappings/clients/${roleClient}`;
    }
    const user = idOf(await read(`/clients/${client}/service-account-user`));
    return `/users/${user}/role-mappings/clients/${roleClient}`;
  };
  return {
    async get() {
      return (await (await call("GET")).json()) as Json;
    },
    async put(body) {
      await call("PUT", body);
    },
    async roles(set, account) {
      const mapped = await read(await mappingPath(set, account));
      if (!isArray(mapped)) throw new ReconcileError("bad_realm");
      return mapped
        .map((role) => (isObject(role) ? role.name : undefined))
        .filter((name): name is string => typeof name === "string")
        .sort();
    },
    async changeRoles(set, account, add, remove) {
      const path = await mappingPath(set, account);
      const roleClient = await clientId(account.roleClient);
      const reps = async (names: readonly string[]): Promise<Json[]> => {
        const out: Json[] = [];
        for (const name of names) {
          out.push(
            await read(
              `/clients/${roleClient}/roles/${encodeURIComponent(name)}`,
            ),
          );
        }
        return out;
      };
      if (add.length > 0) await call("POST", await reps(add), path);
      if (remove.length > 0) await call("DELETE", await reps(remove), path);
    },
  };
}

/** A master-realm admin token by the password grant of admin-cli (the local bootstrap admin). */
export async function passwordToken(
  base: string,
  username: string,
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(
    `${base}/realms/master/protocol/openid-connect/token`,
    {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "admin-cli",
        username,
        password,
      }),
    },
  );
  if (!response.ok) throw new ReconcileError("http_error", response.status);
  const body = (await response.json()) as Json;
  const token = isObject(body) ? body.access_token : undefined;
  if (typeof token !== "string")
    throw new ReconcileError("http_error", response.status);
  return token;
}
