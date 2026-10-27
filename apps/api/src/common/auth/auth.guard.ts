// The global AuthGuard (P5-02, ADR 0062; plan decisions 2 and 5, rulings
// D3 and D7, owner conditions 4, 5 and 6). Deny by default: every route
// needs a valid bearer token unless it is @Public(). In this order:
// 1. verify the token (token-verifier.ts). Any failure is the same 401
//    `unauthenticated` with WWW-Authenticate: Bearer (ProblemFilter), and
//    an unreachable JWKS is 503; either way one `auth.failed` line with
//    the reason and nothing else (the request log carries the correlation
//    id). No audit row: a failure has no verified actor or org (D3);
// 2. check the org_id claim: a lowercase UUIDv7 or 403 `forbidden`
//    (reason org_missing), before anything is written. The claim is a
//    default-organisation hint, never authorisation (D7): what the user
//    may do there comes from the grants source. P5-05 (ADR 0066): the
//    request's org is X-Org-Id when present (a lowercase UUIDv7, or 403
//    `forbidden` reason org_invalid, before anything is written), else
//    the claim;
// 3. provision the user (user-directory.ts); an insert logs one
//    `auth.provisioned` line with the user and org ids, never the sub;
// 3a. (P5-05, ADR 0066, D7) ask the grants source for the user's access
//    in the chosen org: no open membership there is 403 `forbidden`
//    (reason membership_missing) before any revocation check or sessions
//    row. Keys the catalogue no longer knows are counted by the source and
//    logged here once (`grants.unknown_permission`, ids and the count);
// 3b. (P5-04, ADR 0065) check the revocation keys (revocation-store.ts):
//    one Valkey round trip for revoked:sid:<org>:<sid> and
//    revoked:user:<org>:<user>; a hit is 401 `session_expired` (reason
//    revoked_sid or revoked_user) before any session row is touched; the
//    store unreachable is 503 `server_unavailable` (fail closed) with one
//    `auth.revocation_unavailable` line;
// 4. (P5-03, ADR 0063) track the session and the device
//    (session-tracker.ts): X-Device-Id, when present, must be one
//    canonical UUID (checked before provisioning) and, unless the route is
//    @RegistersDevice(), a registered, unrevoked device of this user; the
//    sessions row for (org, sid) is inserted or reused, a revoked or idle
//    one answers 401 `session_expired`, a device failure 401
//    `unauthenticated`; one `auth.failed` line with the reason, and one
//    `auth.session_started` line with ids when a row is inserted;
// 5. set the identity from the access read at 3a (projects, grants and
//    allProjects, the wildcard only the source computes; a claim or a
//    header never sets it), which the interceptor validates and freezes.
//    The token, the sub, the sid and the claims are never logged.
// P5-07 (ADR 0068, owner condition 4): the identity's acr comes from the
// verified token alone (acrOf: exactly "mfa", else "pwd"); no header is
// read for it. The authorization guard (can.guard.ts) runs after this one.
import { isOrgId } from "@bricx/ids/branded";
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { DEVICE_ID_HEADER, deviceIdOf } from "../db/context.hook.js";
import { setIdentity } from "../db/request-context.js";
import { ApiError } from "../errors/api-error.js";
import { GRANTS_SOURCE, type GrantsSource } from "./grants-source.js";
import { IS_PUBLIC } from "./public.decorator.js";
import { REGISTERS_DEVICE } from "./registers-device.decorator.js";
import {
  REVOCATION_STORE,
  type RevocationReason,
  type RevocationStore,
  RevocationUnavailable,
} from "./revocation-store.js";
import {
  SESSION_TRACKER,
  SessionFailure,
  type SessionFailureReason,
  type SessionTracker,
} from "./session-tracker.js";
import {
  AuthFailure,
  type AuthFailureReason,
  TokenVerifier,
  bearerToken,
} from "./token-verifier.js";
import { USER_DIRECTORY, type UserDirectory } from "./user-directory.js";

interface AuthRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly log: {
    info(fields: object, message: string): void;
    warn(fields: object, message: string): void;
  };
}

/** The header that chooses the request's organisation (P5-05, D7). */
export const ORG_ID_HEADER = "x-org-id";

/** The guard's own refusals (403 `forbidden`), beside the token's and the session's. */
export const GUARD_FAILURE_REASONS = Object.freeze([
  "org_invalid",
  "membership_missing",
] as const);
export type GuardFailureReason = (typeof GUARD_FAILURE_REASONS)[number];

/** The org X-Org-Id names: one lowercase UUIDv7, else undefined. */
function orgIdOf(header: string | string[] | undefined): string | undefined {
  return typeof header === "string" && isOrgId(header) ? header : undefined;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
    @Inject(USER_DIRECTORY) private readonly users: UserDirectory,
    @Inject(SESSION_TRACKER) private readonly sessions: SessionTracker,
    @Inject(REVOCATION_STORE) private readonly revocations: RevocationStore,
    @Inject(GRANTS_SOURCE) private readonly grants: GrantsSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") return true;
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic === true) return true;
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const refuse = (
      reason:
        | AuthFailureReason
        | GuardFailureReason
        | SessionFailureReason
        | RevocationReason,
    ): never => {
      request.log.warn({ reason }, "auth.failed");
      if (reason === "jwks_unavailable") {
        throw new ApiError("server_unavailable");
      }
      if (
        reason === "org_missing" ||
        reason === "org_invalid" ||
        reason === "membership_missing"
      ) {
        throw new ApiError("forbidden");
      }
      if (reason.startsWith("session_") || reason.startsWith("revoked_")) {
        throw new ApiError("session_expired");
      }
      throw new ApiError("unauthenticated");
    };
    let verified;
    try {
      verified = await this.verifier.verify(
        bearerToken(request.headers.authorization),
      );
    } catch (error) {
      if (error instanceof AuthFailure) return refuse(error.reason);
      throw error;
    }
    const { orgHint } = verified;
    if (!isOrgId(orgHint)) return refuse("org_missing");
    // The org header's shape, then the device header's, before anything
    // is written.
    const orgHeader = request.headers[ORG_ID_HEADER];
    const chosenOrg = orgIdOf(orgHeader);
    if (orgHeader !== undefined && chosenOrg === undefined) {
      return refuse("org_invalid");
    }
    const orgId = chosenOrg ?? orgHint;
    const header = request.headers[DEVICE_ID_HEADER];
    const deviceId = deviceIdOf(header);
    if (header !== undefined && deviceId === undefined) {
      return refuse("device_unknown");
    }
    const { userId, created } = await this.users.provision({
      subject: verified.subject,
      orgId,
    });
    if (created) {
      request.log.info({ userId, orgId }, "auth.provisioned");
    }
    const access = await this.grants.grantsFor({ userId, orgId });
    if (access === undefined) return refuse("membership_missing");
    if (access.unknownKeys !== undefined && access.unknownKeys > 0) {
      request.log.warn(
        { userId, orgId, count: access.unknownKeys },
        "grants.unknown_permission",
      );
    }
    let revoked: RevocationReason | undefined;
    try {
      revoked = await this.revocations.check({
        orgId,
        userId,
        keycloakSid: verified.sessionId,
      });
    } catch (error) {
      if (error instanceof RevocationUnavailable) {
        request.log.warn({}, "auth.revocation_unavailable");
        throw new ApiError("server_unavailable");
      }
      throw error;
    }
    if (revoked !== undefined) return refuse(revoked);
    const registersDevice =
      this.reflector.get<boolean | undefined>(
        REGISTERS_DEVICE,
        context.getHandler(),
      ) === true;
    let session;
    try {
      session = await this.sessions.track({
        userId,
        orgId,
        keycloakSid: verified.sessionId,
        deviceId,
        registersDevice,
      });
    } catch (error) {
      if (error instanceof SessionFailure) return refuse(error.reason);
      throw error;
    }
    if (session.created) {
      request.log.info(
        { sessionId: session.sessionId, userId, orgId },
        "auth.session_started",
      );
    }
    setIdentity({
      userId,
      orgId,
      projectIds: access.projectIds,
      allProjects: access.allProjects,
      grants: access.grants,
      membershipGrants: access.membershipGrants,
      sessionId: session.sessionId,
      deviceId: session.deviceId,
      acr: verified.acr,
    });
    return true;
  }
}
