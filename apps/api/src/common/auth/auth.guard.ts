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
//    may do there comes from the grants source;
// 3. provision the user (user-directory.ts); an insert logs one
//    `auth.provisioned` line with the user and org ids, never the sub;
// 4. ask the grants source for the user's projects and grants (none until
//    P5-05) and set the identity, which the interceptor validates and
//    freezes. The token, the sub and the claims are never logged.
import { isOrgId } from "@bricx/ids/branded";
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { setIdentity } from "../db/request-context.js";
import { ApiError } from "../errors/api-error.js";
import { GRANTS_SOURCE, type GrantsSource } from "./grants-source.js";
import { IS_PUBLIC } from "./public.decorator.js";
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

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
    @Inject(USER_DIRECTORY) private readonly users: UserDirectory,
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
    const refuse = (reason: AuthFailureReason): never => {
      request.log.warn({ reason }, "auth.failed");
      if (reason === "jwks_unavailable") {
        throw new ApiError("server_unavailable");
      }
      if (reason === "org_missing") throw new ApiError("forbidden");
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
    const { userId, created } = await this.users.provision({
      subject: verified.subject,
      orgId: orgHint,
    });
    if (created) {
      request.log.info({ userId, orgId: orgHint }, "auth.provisioned");
    }
    const access = await this.grants.grantsFor({ userId, orgId: orgHint });
    setIdentity({
      userId,
      orgId: orgHint,
      projectIds: access.projectIds,
      grants: access.grants,
    });
    return true;
  }
}
