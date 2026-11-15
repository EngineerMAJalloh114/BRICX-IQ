// @FreshAuth() (P6-06c, ADR 0085; owner condition C4, answer Q3 as changed
// 2026-11-12): a route that only a freshly authenticated, multi-factor
// session may call (ownership transfer start and accept).
// - The AuthGuard keeps the verified token's auth_time for the request
//   (setAuthTime); a malformed one never gets here (the verifier refuses
//   it on every route, auth_time_invalid).
// - FreshAuthGuard, after the CanGuard, on a marked handler only: acr must
//   be mfa, auth_time present, at most now + CLOCK_TOLERANCE_SECONDS and
//   at most FRESH_AUTH_MAX_AGE_SECONDS old, on the injected Clock. iat is
//   never read: a refreshed token has a new iat and keeps its auth_time.
// - Otherwise 401 auth.reauth_required with the RFC 9470 challenge
//   REAUTH_CHALLENGE (the client signs in again with prompt=login,
//   acr_values=mfa, max_age=300; proven live in
//   tooling/keycloak-realm/test/realm-login.int.test.ts) and one
//   auth.reauth_required line with the cause; never the token or subject.
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  applyDecorators,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiExtension } from "@nestjs/swagger";
import { CLOCK, type Clock } from "../clock.js";
import {
  currentRequestContext,
  requestSlot,
  setRequestSlot,
} from "../db/request-context.js";
import { ApiError } from "../errors/api-error.js";
import { CLOCK_TOLERANCE_SECONDS, MFA_ACR } from "./token-verifier.js";

/** How old auth_time may be on a @FreshAuth() route (seconds; a constant, Q5). */
export const FRESH_AUTH_MAX_AGE_SECONDS = 300;
/** The challenge a refused @FreshAuth() request carries (RFC 9470). */
export const REAUTH_CHALLENGE = `Bearer error="insufficient_user_authentication", acr_values="mfa", max_age=${String(FRESH_AUTH_MAX_AGE_SECONDS)}`;

export const FRESH_AUTH = "bricx:fresh-auth";
export const FRESH_AUTH_EXTENSION = "x-bricx-fresh-auth";

export const FreshAuth = () =>
  applyDecorators(
    SetMetadata(FRESH_AUTH, true),
    ApiExtension(FRESH_AUTH_EXTENSION, FRESH_AUTH_MAX_AGE_SECONDS),
  );

interface FreshRequest {
  readonly log: { warn(fields: object, message: string): void };
}

const AUTH_TIME_SLOT = Symbol("bricx:auth-time");

/** Keeps the verified auth_time for the rest of the request (the AuthGuard). */
export function setAuthTime(authTime: number | undefined): void {
  setRequestSlot(AUTH_TIME_SLOT, authTime);
}

/** Why a @FreshAuth() request was refused (logged, never answered). */
export type ReauthCause = "acr" | "missing" | "future" | "stale";

/** The cause a request with `acr` and `authTime` is refused for at `nowMs`, or undefined. */
export function reauthCause(
  acr: unknown,
  authTime: unknown,
  nowMs: number,
): ReauthCause | undefined {
  if (acr !== MFA_ACR) return "acr";
  if (typeof authTime !== "number" || !Number.isSafeInteger(authTime)) {
    return "missing";
  }
  const now = Math.floor(nowMs / 1000);
  if (authTime > now + CLOCK_TOLERANCE_SECONDS) return "future";
  if (now - authTime > FRESH_AUTH_MAX_AGE_SECONDS) return "stale";
  return undefined;
}

@Injectable()
export class FreshAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== "http") return true;
    if (
      this.reflector.get<boolean | undefined>(
        FRESH_AUTH,
        context.getHandler(),
      ) !== true
    ) {
      return true;
    }
    const identity = currentRequestContext()?.identity;
    const cause = reauthCause(
      identity?.acr,
      requestSlot(AUTH_TIME_SLOT),
      this.clock.now(),
    );
    if (cause === undefined) return true;
    context
      .switchToHttp()
      .getRequest<FreshRequest>()
      .log.warn({ cause }, "auth.reauth_required");
    throw new ApiError("auth.reauth_required");
  }
}
