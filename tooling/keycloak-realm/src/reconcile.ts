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
// The managed list is closed: anything else in the file still needs a
// fresh realm locally (`pnpm dev:reset`) or the P13-01 step.
import { isObject, type Json } from "./normalise.js";

export const MANAGED_FIELDS = [
  "passwordPolicy",
  "adminEventsEnabled",
  "adminEventsDetailsEnabled",
] as const;
export const MANAGED_ATTRIBUTES = ["adminEventsExpiration"] as const;

type Field = (typeof MANAGED_FIELDS)[number];
type Attribute = (typeof MANAGED_ATTRIBUTES)[number];
type JsonObject = { readonly [key: string]: Json };

export interface Desired {
  readonly fields: Readonly<Record<Field, string | boolean>>;
  readonly attributes: Readonly<Record<Attribute, string>>;
}

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
  };
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

/** The admin API of one realm: its representation, read and written whole. */
export interface RealmAdmin {
  get(): Promise<Json>;
  put(body: Json): Promise<void>;
}

/** Applies (or, with "check", only reports) the managed settings. */
export async function reconcile(
  admin: RealmAdmin,
  desired: Desired,
  mode: "apply" | "check",
): Promise<{ drift: string[]; applied: string[] }> {
  const live = await admin.get();
  const drift = driftOf(live, desired);
  if (mode === "check" || drift.length === 0) return { drift, applied: [] };
  await admin.put(withDesired(live, desired));
  if (driftOf(await admin.get(), desired).length > 0) {
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
  const call = async (method: string, body?: Json): Promise<Response> => {
    const init: RequestInit = {
      method,
      redirect: "manual",
      headers: {
        authorization: `Bearer ${await token()}`,
        "content-type": "application/json",
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetchImpl(url, init);
    if (!response.ok) {
      throw new ReconcileError("http_error", response.status);
    }
    return response;
  };
  return {
    async get() {
      return (await (await call("GET")).json()) as Json;
    },
    async put(body) {
      await call("PUT", body);
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
