// Test-only authentication (P5-02, ADR 0062; owner condition 1). Every
// suite goes through the real AuthGuard with real RS256 tokens:
// - TestIssuer: a key pair and a local JWKS server at
//   http://127.0.0.1:<port>/realms/test/protocol/openid-connect/certs,
//   so KEYCLOAK_ISSUER is a real issuer URL; it counts fetches, rotates
//   its key and can be switched down;
// - roleGrants(): the test-only grants source. Before P5-05 production
//   binds noGrants (deny all); a test names, per user id, the projects and
//   @bricx/permissions role bundles that user holds. This is the only place
//   role names become grants: src has no role-claim path;
// - fixedUsers(): a user directory without a database for the unit suites
//   (the integration suites provision through Postgres);
// - seedUsers(): users rows with known ids, so provisioning returns them.
// P5-03 (ADR 0063):
// - every test token carries a Keycloak session id (sid: TEST_SID);
// - fixedSessions(): a session tracker without a database for the unit
//   suites (the integration suites track through Postgres);
// - seedDevices(): devices rows of known users.
// P5-04 (ADR 0065):
// - fixedRevocations(): a revocation store without Valkey for the unit
//   suites: the revoked sids and users it was given, or unavailable.
// P5-05 (ADR 0066, phase ruling D7):
// - roleGrants() answers undefined (no membership in the org: 403) for a
//   user it was not given when membersOnly is set, and a TestAccess may
//   ask for allProjects (the wildcard the production source computes);
// - applyAccess(): roles, role_permissions, memberships and
//   project_memberships rows for one user in one org, so the integration
//   suites run on the production DbGrantsSource (no test-only source).
// src never imports this folder (Semgrep bricx-src-imports-test-support).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type UserId, isProjectId } from "@bricx/ids/branded";
import type { Grant } from "@bricx/permissions/ability";
import { PermissionError } from "@bricx/permissions/errors";
import type { Overrides } from "@bricx/permissions/overrides";
import {
  ROLES,
  ROLE_IDS,
  type RoleId,
  grantsForRole,
} from "@bricx/permissions/roles";
import {
  type CryptoKey,
  type JWK,
  SignJWT,
  exportJWK,
  generateKeyPair,
} from "jose";
import type {
  Access,
  GrantsSource,
} from "../../src/common/auth/grants-source.js";
import {
  type RevocationCheck,
  type RevocationReason,
  type RevocationStore,
  RevocationUnavailable,
} from "../../src/common/auth/revocation-store.js";
import {
  SessionFailure,
  type SessionFailureReason,
  type SessionTrackInput,
  type SessionTracker,
  type TrackedSession,
} from "../../src/common/auth/session-tracker.js";
import type { UserDirectory } from "../../src/common/auth/user-directory.js";

export const TEST_AUDIENCE = "bricx-api";
/** The Keycloak session id (sid) every test token carries unless overridden. */
export const TEST_SID = "test-sid-0001";
/**
 * The default sid of a token for `sub`: Keycloak never gives two users
 * one session id, so two subs in one org must not share a sessions row
 * (session_user_mismatch).
 */
export const sidFor = (sub: string): string => `${TEST_SID}:${sub}`;
/** The session id fixedSessions() hands back. */
export const TEST_SESSION_ID = "0199e1a0-0000-7000-8000-00000000005e";
export const TEST_REALM_PATH = "/realms/test";
const CERTS_PATH = `${TEST_REALM_PATH}/protocol/openid-connect/certs`;

interface SigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly jwk: JWK;
}

let kidCounter = 0;
async function newKey(): Promise<SigningKey> {
  kidCounter += 1;
  // Taken before the await: keys made in parallel get distinct kids.
  const kid = `test-key-${String(kidCounter)}`;
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  return {
    kid,
    privateKey,
    jwk: { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" },
  };
}

/** Claims a test token carries; `undefined` drops a claim. */
export interface TestClaims {
  readonly sub?: string | undefined;
  readonly org_id?: unknown;
  readonly iss?: string | undefined;
  readonly aud?: string | string[] | undefined;
  readonly typ?: string | undefined;
  /** The Keycloak session id; unknown so a test can send a non-string. */
  readonly sid?: unknown;
  /** Seconds since the epoch. */
  readonly iat?: number | undefined;
  readonly exp?: number | undefined;
  readonly nbf?: number | undefined;
  readonly [claim: string]: unknown;
}

export interface SignOptions {
  /** A key the JWKS does not publish (signature or kid unknown). */
  readonly key?: "current" | "unpublished";
  /** Overrides the kid header (undefined drops it). */
  readonly kid?: string | undefined;
  /** The JOSE header typ (Keycloak sends JWT). */
  readonly headerTyp?: string;
}

export class TestIssuer {
  /** JWKS requests served (any status). */
  fetches = 0;
  /** When true the certs endpoint answers 503. */
  down = false;
  /** When true the certs endpoint never answers (a fetch timeout). */
  hang = false;
  /** Seconds since the epoch for iat/exp defaults. */
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000);

  private constructor(
    private readonly server: Server,
    readonly issuer: string,
    private current: SigningKey,
    private readonly unpublished: SigningKey,
  ) {}

  static async start(): Promise<TestIssuer> {
    const [current, unpublished] = await Promise.all([newKey(), newKey()]);
    const ref: { issuer?: TestIssuer } = {};
    const server = createServer((request, response) => {
      const { issuer } = ref;
      if (issuer === undefined || request.url !== CERTS_PATH) {
        response.writeHead(404).end();
        return;
      }
      issuer.fetches += 1;
      if (issuer.hang) return;
      if (issuer.down) {
        response.writeHead(503).end();
        return;
      }
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ keys: [issuer.current.jwk] }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    ref.issuer = new TestIssuer(
      server,
      `http://127.0.0.1:${String(port)}${TEST_REALM_PATH}`,
      current,
      unpublished,
    );
    return ref.issuer;
  }

  /** The API environment keys that point at this issuer. */
  env(): Record<string, string> {
    return { KEYCLOAK_ISSUER: this.issuer };
  }

  /** The kid the JWKS publishes now. */
  get kid(): string {
    return this.current.kid;
  }

  /** Replaces the published key: tokens signed before carry an unknown kid. */
  async rotate(): Promise<void> {
    this.current = await newKey();
  }

  /**
   * An RS256 token as Keycloak shapes it (typ Bearer, aud bricx-api, a
   * 300 s lifetime); every claim can be overridden or dropped.
   */
  async token(claims: TestClaims = {}, options: SignOptions = {}) {
    const now = this.nowSeconds();
    const payload: Record<string, unknown> = {
      iss: this.issuer,
      aud: TEST_AUDIENCE,
      typ: "Bearer",
      iat: now,
      exp: now + 300,
      sub: "test-subject",
      ...claims,
    };
    if (!("sid" in claims)) {
      payload.sid =
        typeof payload.sub === "string" ? sidFor(payload.sub) : TEST_SID;
    }
    for (const [name, value] of Object.entries(payload)) {
      if (value === undefined) Reflect.deleteProperty(payload, name);
    }
    const key = options.key === "unpublished" ? this.unpublished : this.current;
    const kid = "kid" in options ? options.kid : key.kid;
    return new SignJWT(payload)
      .setProtectedHeader({
        alg: "RS256",
        typ: options.headerTyp ?? "JWT",
        ...(kid === undefined ? {} : { kid }),
      })
      .sign(key.privateKey);
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

/** The Authorization header for `token`. */
export const bearer = (token: string): { authorization: string } => ({
  authorization: `Bearer ${token}`,
});

/**
 * What one test user holds: projects and role names (test-only). A name
 * that is not a ROLE_IDS entry, exact case, grants nothing.
 */
export interface TestAccess {
  readonly projects?: readonly string[];
  readonly roles?: readonly string[];
  /** The wildcard (every project of the org), as DbGrantsSource sets it. */
  readonly allProjects?: boolean;
}

const ROLE_ID_SET: ReadonlySet<string> = new Set(ROLE_IDS);
const isRoleId = (value: string): value is RoleId => ROLE_ID_SET.has(value);

/** The grants of `roles` over `projects`, as P5-05's memberships will give. */
export function grantsOf(access: TestAccess): Grant[] {
  const projectIds = (access.projects ?? []).filter(isProjectId);
  const grants: Grant[] = [];
  for (const role of new Set(access.roles ?? [])) {
    if (!isRoleId(role)) continue;
    try {
      grants.push(...grantsForRole(role, { projectIds }));
    } catch (error) {
      // A bundle the user has no targets for (site roles) grants nothing.
      if (error instanceof PermissionError) continue;
      throw error;
    }
  }
  return grants;
}

export interface RoleGrantsOptions {
  /**
   * A user the source was not given has no membership in the org
   * (undefined: the guard answers 403 membership_missing); without it
   * such a user is a member with nothing granted.
   */
  readonly membersOnly?: boolean;
}

/**
 * The test-only grants source: per user id, the projects and role
 * bundles; anyone else gets nothing (or, with membersOnly, no
 * membership). A Map may be changed between requests (a suite that
 * varies one user's access). `calls` records each lookup.
 */
export function roleGrants(
  byUser:
    ReadonlyMap<string, TestAccess> | Readonly<Record<string, TestAccess>> = {},
  options: RoleGrantsOptions = {},
): GrantsSource & { calls: { userId: string; orgId: string }[] } {
  const calls: { userId: string; orgId: string }[] = [];
  const isMap = (
    value: typeof byUser,
  ): value is ReadonlyMap<string, TestAccess> => value instanceof Map;
  const lookup = (userId: string): TestAccess | undefined => {
    if (isMap(byUser)) return byUser.get(userId);
    return Object.hasOwn(byUser, userId) ? byUser[userId] : undefined;
  };
  return {
    calls,
    grantsFor(user): Promise<Access | undefined> {
      calls.push({ userId: user.userId, orgId: user.orgId });
      const access = lookup(user.userId);
      if (access === undefined) {
        return Promise.resolve(
          options.membersOnly === true
            ? undefined
            : {
                projectIds: [],
                grants: [],
                membershipGrants: [],
                allProjects: false,
              },
        );
      }
      return Promise.resolve({
        projectIds: [...(access.projects ?? [])],
        grants: grantsOf(access),
        // A test user's roles are memberships: no elevation (amendment 3).
        membershipGrants: grantsOf(access),
        allProjects: access.allProjects === true,
      });
    },
  };
}

/**
 * A grants source that answers `access` for everyone (unit suites);
 * undefined is "no membership in this org".
 */
export function fixedAccess(access: Access | undefined): GrantsSource {
  return { grantsFor: () => Promise.resolve(access) };
}

/**
 * A user directory without a database: sub → user id from `bySub`, else
 * a fixed fallback id; `created` is true the first time a sub is seen.
 * `provisioned` records each call.
 */
export function fixedUsers(
  bySub: Readonly<Record<string, string>>,
  fallback: string,
): UserDirectory & { provisioned: { subject: string; orgId: string }[] } {
  const provisioned: { subject: string; orgId: string }[] = [];
  const seen = new Set<string>();
  return {
    provisioned,
    provision(input) {
      provisioned.push({ subject: input.subject, orgId: input.orgId });
      const userId = Object.hasOwn(bySub, input.subject)
        ? (bySub[input.subject] ?? fallback)
        : fallback;
      const created = !seen.has(input.subject);
      seen.add(input.subject);
      return Promise.resolve({ userId, created });
    },
  };
}

export interface FixedSessionsOptions {
  /** Registered device ids; any other X-Device-Id is device_unknown. */
  readonly devices?: readonly string[];
  /** Registered device ids that are revoked (device_revoked). */
  readonly revoked?: readonly string[];
  /** Every call fails with this reason. */
  readonly fail?: SessionFailureReason;
  readonly sessionId?: string;
}

/**
 * A session tracker without a database: hands back one session id,
 * knows the registered devices it was given, and records every call.
 */
export function fixedSessions(
  options: FixedSessionsOptions = {},
): SessionTracker & { tracked: SessionTrackInput[] } {
  const tracked: SessionTrackInput[] = [];
  const seen = new Set<string>();
  const devices = new Set(options.devices ?? []);
  const revoked = new Set(options.revoked ?? []);
  return {
    tracked,
    track(input): Promise<TrackedSession> {
      tracked.push({ ...input });
      if (options.fail !== undefined) {
        return Promise.reject(new SessionFailure(options.fail));
      }
      let deviceId: string | undefined;
      if (input.deviceId !== undefined && !input.registersDevice) {
        if (revoked.has(input.deviceId)) {
          return Promise.reject(new SessionFailure("device_revoked"));
        }
        if (!devices.has(input.deviceId)) {
          return Promise.reject(new SessionFailure("device_unknown"));
        }
        deviceId = input.deviceId;
      }
      const key = `${input.orgId}/${input.keycloakSid}`;
      const created = !seen.has(key);
      seen.add(key);
      return Promise.resolve({
        sessionId: options.sessionId ?? TEST_SESSION_ID,
        deviceId,
        created,
      });
    },
  };
}

export interface FixedRevocationsOptions {
  /** Revoked Keycloak session ids, as `<orgId>/<sid>` (org-scoped). */
  readonly sids?: readonly string[];
  /** Revoked users, as `<orgId>/<userId>` (org-scoped). */
  readonly users?: readonly string[];
  /** Every check fails as if Valkey were unreachable. */
  readonly unavailable?: boolean;
  /** Called on every check (for ordering assertions). */
  readonly onCheck?: () => void;
}

/**
 * A revocation store without Valkey: answers from the lists it was given
 * (a revoked sid before a revoked user, as the real store does) and
 * records every check.
 */
export function fixedRevocations(
  options: FixedRevocationsOptions = {},
): RevocationStore & { checks: RevocationCheck[] } {
  const checks: RevocationCheck[] = [];
  const sids = new Set(options.sids ?? []);
  const users = new Set(options.users ?? []);
  return {
    checks,
    check(input): Promise<RevocationReason | undefined> {
      checks.push({ ...input });
      options.onCheck?.();
      if (options.unavailable === true) {
        return Promise.reject(new RevocationUnavailable());
      }
      if (sids.has(`${input.orgId}/${input.keycloakSid}`)) {
        return Promise.resolve("revoked_sid");
      }
      if (users.has(`${input.orgId}/${input.userId}`)) {
        return Promise.resolve("revoked_user");
      }
      return Promise.resolve(undefined);
    },
  };
}

/** Something that runs SQL as the test superuser. */
export type AdminQuery = (text: string, params?: unknown[]) => Promise<unknown>;

/**
 * Inserts users rows (as the test superuser) with known ids, so the
 * guard's provisioning returns these ids for these subs (ON CONFLICT).
 */
export async function seedUsers(
  admin: AdminQuery,
  users: readonly { readonly id: UserId | string; readonly sub: string }[],
): Promise<void> {
  for (const user of users) {
    await admin(
      `INSERT INTO bricx.users (id, keycloak_sub, created_at, last_seen_at)
       VALUES ($1, $2, now(), now()) ON CONFLICT (keycloak_sub) DO NOTHING`,
      [user.id, user.sub],
    );
  }
}

/**
 * Inserts devices rows (as the test superuser) for known users, so the
 * guard's device check finds them. `revokedAt` closes a device.
 */
export async function seedDevices(
  admin: AdminQuery,
  devices: readonly {
    readonly id: string;
    readonly userId: UserId | string;
    readonly revokedAt?: string;
  }[],
): Promise<void> {
  for (const device of devices) {
    await admin(
      `INSERT INTO bricx.devices (id, user_id, platform, name, created_at, last_seen_at, revoked_at)
       VALUES ($1, $2, 'web', 'test device', now() - interval '1 minute', now() - interval '1 minute', $3)
       ON CONFLICT (id) DO NOTHING`,
      [device.id, device.userId, device.revokedAt ?? null],
    );
  }
}

/** Something that runs SQL as the test superuser and returns the rows. */
export type AdminRows = (
  text: string,
  params?: unknown[],
) => Promise<readonly Record<string, unknown>[]>;

/**
 * What one user holds in one org, as rows: one role (a ROLE_IDS entry is
 * that bundle, copied into role_permissions as bootstrap does, except
 * `owner`, which is virtual: system_key alone; any other valid key is a
 * custom role, empty unless the suite filled it; a name that is no role
 * key at all is the empty role `member`), the org membership with it, and
 * a project membership with it on each of `projects`, with `overrides`.
 */
export interface SeededAccess {
  readonly orgId: string;
  readonly userId: UserId | string;
  readonly role: string;
  readonly projects?: readonly string[];
  readonly overrides?: Overrides;
}

const ROLE_KEY = /^[a-z][a-z0-9_]{0,63}$/;

let seedCounter = 0;
/** A fresh UUIDv7 for a seeded row (never collides with a suite's own ids). */
export const seedId = (): string => {
  seedCounter += 1;
  return `0199e1a9-0000-7000-8000-${seedCounter.toString(16).padStart(12, "0")}`;
};

const idOf = (rows: readonly Record<string, unknown>[]): string | undefined => {
  const id = rows[0]?.id;
  return typeof id === "string" ? id : undefined;
};

/**
 * The open role `key` of `orgId` (as the test superuser), made if absent:
 * a ROLE_IDS key gets its system_key and, unless it is `owner`, its
 * bundle as open role_permissions rows; any other key is an empty role.
 */
export async function seedRole(
  admin: AdminRows,
  orgId: string,
  key: string,
): Promise<string> {
  const existing = idOf(
    await admin(
      "SELECT id::text FROM bricx.roles WHERE org_id = $1 AND key = $2 AND archived_at IS NULL",
      [orgId, key],
    ),
  );
  if (existing !== undefined) return existing;
  const system = isRoleId(key) ? key : undefined;
  const id = seedId();
  await admin(
    `INSERT INTO bricx.roles (id, org_id, key, name, system_key, created_at, updated_at)
     VALUES ($1, $2, $3, $3, $4, now() - interval '1 minute', now() - interval '1 minute')`,
    [id, orgId, key, system ?? null],
  );
  if (system !== undefined && system !== "owner") {
    for (const permission of ROLES[system]) {
      await admin(
        `INSERT INTO bricx.role_permissions (id, org_id, role_id, permission, granted_at)
         VALUES ($1, $2, $3, $4, now() - interval '1 minute')`,
        [seedId(), orgId, id, permission],
      );
    }
  }
  return id;
}

/**
 * Closes the user's open memberships in the org and writes the ones
 * `access` names (as the test superuser), so the next request reads
 * exactly this access through the production grants source.
 */
export async function applyAccess(
  admin: AdminRows,
  access: SeededAccess,
): Promise<void> {
  const { orgId, userId } = access;
  for (const table of ["memberships", "project_memberships"]) {
    await admin(
      `UPDATE bricx.${table} SET removed_at = now() WHERE org_id = $1 AND user_id = $2 AND removed_at IS NULL`,
      [orgId, userId],
    );
  }
  const roleId = await seedRole(
    admin,
    orgId,
    ROLE_KEY.test(access.role) ? access.role : "member",
  );
  await admin(
    `INSERT INTO bricx.memberships (id, org_id, user_id, role_id, created_at)
     VALUES ($1, $2, $3, $4, now() - interval '1 minute')`,
    [seedId(), orgId, userId, roleId],
  );
  for (const projectId of access.projects ?? []) {
    await admin(
      `INSERT INTO bricx.project_memberships (id, org_id, project_id, user_id, role_id, overrides, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, now() - interval '1 minute')`,
      [
        seedId(),
        orgId,
        projectId,
        userId,
        roleId,
        JSON.stringify(access.overrides ?? {}),
      ],
    );
  }
}
