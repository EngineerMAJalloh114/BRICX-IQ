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
// src never imports this folder (Semgrep bricx-src-imports-test-support).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type UserId, isProjectId } from "@bricx/ids/branded";
import type { Grant } from "@bricx/permissions/ability";
import { PermissionError } from "@bricx/permissions/errors";
import { ROLE_IDS, type RoleId, grantsForRole } from "@bricx/permissions/roles";
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
}

const ROLES: ReadonlySet<string> = new Set(ROLE_IDS);
const isRoleId = (value: string): value is RoleId => ROLES.has(value);

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

/**
 * The test-only grants source: per user id, the projects and role
 * bundles; anyone else gets nothing. A Map may be changed between
 * requests (a suite that varies one user's access). `calls` records each
 * lookup.
 */
export function roleGrants(
  byUser:
    ReadonlyMap<string, TestAccess> | Readonly<Record<string, TestAccess>> = {},
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
    grantsFor(user): Promise<Access> {
      calls.push({ userId: user.userId, orgId: user.orgId });
      const access = lookup(user.userId);
      if (access === undefined) {
        return Promise.resolve({ projectIds: [], grants: [] });
      }
      return Promise.resolve({
        projectIds: [...(access.projects ?? [])],
        grants: grantsOf(access),
      });
    },
  };
}

/** A grants source that answers `access` for everyone (unit suites). */
export function fixedAccess(access: Access): GrantsSource {
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
