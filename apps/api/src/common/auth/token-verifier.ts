// Bearer token verification (P5-02, ADR 0061 jose, ADR 0062; plan
// decisions 3 and 4, owner condition 5). One jose jwtVerify call with:
// - algorithms RS256 only (Keycloak's realm key; anything else needs an ADR);
// - issuer = KEYCLOAK_ISSUER, audience = bricx-api, exp required;
// - exp and nbf with a 5 s tolerance, judged at the injected Clock's time
//   (jose's currentDate), never the process clock;
// then sub (1-255 characters) and Keycloak's typ claim (Bearer: an ID or
// refresh token is refused). Keys come from the issuer's JWKS
// (createRemoteJWKSet): cached, an unknown kid refetches at most once per
// cooldown, each fetch has a timeout. A failed fetch is remembered for a
// short cooldown on the Clock, so a JWKS outage costs one fetch per
// cooldown, not one per request. Every failure is an AuthFailure with a
// reason for the log; the response never shows it (auth.guard.ts).
import {
  type FetchImplementation,
  type JWTPayload,
  createRemoteJWKSet,
  customFetch,
  errors,
  jwtVerify,
} from "jose";
import type { Clock } from "../clock.js";

/** The only signature algorithm accepted (plan decision 3). */
export const TOKEN_ALGORITHMS = Object.freeze(["RS256"] as const);
/** Seconds of exp/nbf leeway (plan decision 4). */
export const CLOCK_TOLERANCE_SECONDS = 5;
/** Longest token read; anything longer is malformed before it is parsed. */
export const MAX_TOKEN_LENGTH = 8_192;
/** Longest sub kept (bricx.users.keycloak_sub is bounded the same way). */
export const MAX_SUBJECT_LENGTH = 255;
/**
 * A sub is printable ASCII, the same rule provisionUser() applies
 * (@bricx/db/users), checked here so a token can only be refused with a
 * 401 and never fail provisioning with a 500 (P5-03, P5-02 review).
 */
const SUBJECT = /^[\x21-\x7e]+$/;
/** Keycloak's typ claim on an access token. */
export const ACCESS_TOKEN_TYPE = "Bearer";

/**
 * Why a token was refused: logged as `auth.failed` { reason }, never sent.
 * org_missing is a 403 and jwks_unavailable a 503; the rest are 401.
 */
export const AUTH_FAILURE_REASONS = Object.freeze([
  "token_missing",
  "token_malformed",
  "alg_refused",
  "key_unknown",
  "signature_invalid",
  "issuer_mismatch",
  "audience_mismatch",
  "expired",
  "not_yet_valid",
  "subject_missing",
  "type_refused",
  "org_missing",
  "jwks_unavailable",
] as const);
export type AuthFailureReason = (typeof AUTH_FAILURE_REASONS)[number];

export class AuthFailure extends Error {
  constructor(readonly reason: AuthFailureReason) {
    super(`auth failure: ${reason}`);
  }
}
Object.defineProperty(AuthFailure.prototype, "name", { value: "AuthFailure" });

export interface JwksOptions {
  /** A JWKS request gives up after this long. */
  readonly timeoutMs: number;
  /** An unknown kid refetches only this long after the last fetch. */
  readonly cooldownMs: number;
  /** Keys are refetched once they are this old. */
  readonly cacheMaxAgeMs: number;
  /** After a failed fetch, requests answer 503 for this long (on the Clock). */
  readonly failureCooldownMs: number;
  /** Test-only: the fetch the JWKS requests go through. */
  readonly fetch?: FetchImplementation | undefined;
}

/** Production JWKS settings (for architect review). */
export const JWKS_DEFAULTS: JwksOptions = Object.freeze({
  timeoutMs: 5_000,
  cooldownMs: 30_000,
  cacheMaxAgeMs: 600_000,
  failureCooldownMs: 5_000,
});

export interface VerifierSettings {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
}

export interface VerifiedToken {
  readonly subject: string;
  /** The org_id claim as sent (any JSON value); the guard checks it. */
  readonly orgHint: unknown;
  /** Keycloak's session id (the sid claim, P5-03): the sessions row key. */
  readonly sessionId: string;
}

/** The token after "Bearer ", or an AuthFailure (missing or malformed). */
export function bearerToken(header: string | string[] | undefined): string {
  if (header === undefined) throw new AuthFailure("token_missing");
  if (typeof header !== "string" || header.length > MAX_TOKEN_LENGTH + 7) {
    throw new AuthFailure("token_malformed");
  }
  const match =
    /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)$/i.exec(header);
  const token = match?.[1];
  if (token === undefined || token.length > MAX_TOKEN_LENGTH) {
    throw new AuthFailure("token_malformed");
  }
  return token;
}

/**
 * The reason for an error jose threw (claim names come from jose itself).
 * Anything jose did not classify is the token's problem, token_malformed
 * (401); only a JWKS failure is jwks_unavailable (503). A failed fetch is
 * classified by key() before it gets here (P5-03, P5-02 review point a).
 */
export function reasonFor(error: unknown): AuthFailureReason {
  if (error instanceof AuthFailure) return error.reason;
  if (error instanceof errors.JWTExpired) return "expired";
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === "iss") return "issuer_mismatch";
    if (error.claim === "aud") return "audience_mismatch";
    if (error.claim === "nbf") return "not_yet_valid";
    return "token_malformed";
  }
  if (error instanceof errors.JOSEAlgNotAllowed) return "alg_refused";
  if (
    error instanceof errors.JWKSNoMatchingKey ||
    error instanceof errors.JWKSMultipleMatchingKeys
  ) {
    return "key_unknown";
  }
  if (error instanceof errors.JWSSignatureVerificationFailed) {
    return "signature_invalid";
  }
  if (
    error instanceof errors.JWKSTimeout ||
    error instanceof errors.JWKSInvalid ||
    error instanceof errors.JWKInvalid
  ) {
    return "jwks_unavailable";
  }
  if (
    error instanceof errors.JWSInvalid ||
    error instanceof errors.JWTInvalid ||
    error instanceof errors.JOSENotSupported
  ) {
    return "token_malformed";
  }
  return "token_malformed";
}

export class TokenVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private failedAt: number | undefined;

  constructor(
    private readonly settings: VerifierSettings,
    private readonly clock: Clock,
    private readonly options: JwksOptions = JWKS_DEFAULTS,
  ) {
    this.jwks = createRemoteJWKSet(new URL(settings.jwksUrl), {
      timeoutDuration: options.timeoutMs,
      cooldownDuration: options.cooldownMs,
      cacheMaxAge: options.cacheMaxAgeMs,
      ...(options.fetch === undefined ? {} : { [customFetch]: options.fetch }),
    });
  }

  /** The key for a token header: the JWKS, unless a fetch failed just now. */
  private async key(
    ...args: Parameters<ReturnType<typeof createRemoteJWKSet>>
  ) {
    const now = this.clock.now();
    if (
      this.failedAt !== undefined &&
      now < this.failedAt + this.options.failureCooldownMs
    ) {
      throw new AuthFailure("jwks_unavailable");
    }
    try {
      return await this.jwks(...args);
    } catch (error) {
      // A missing or ambiguous key is the token's problem, not the JWKS's.
      if (
        error instanceof errors.JWKSNoMatchingKey ||
        error instanceof errors.JWKSMultipleMatchingKeys
      ) {
        throw error;
      }
      this.failedAt = now;
      // Everything else here is the JWKS's problem: jose's JWKSTimeout, its
      // bare JOSEError for a non-200 or non-JSON response, or the fetch's
      // own network error (P5-03, P5-02 review point a).
      throw new AuthFailure("jwks_unavailable");
    }
  }

  /** The token's subject and org hint, or an AuthFailure with its reason. */
  async verify(token: string): Promise<VerifiedToken> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, (...args) => this.key(...args), {
        algorithms: [...TOKEN_ALGORITHMS],
        issuer: this.settings.issuer,
        audience: this.settings.audience,
        requiredClaims: ["exp", "iss", "aud"],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        currentDate: new Date(this.clock.now()),
      }));
    } catch (error) {
      throw new AuthFailure(reasonFor(error));
    }
    const { sub } = payload;
    if (
      typeof sub !== "string" ||
      sub.length === 0 ||
      sub.length > MAX_SUBJECT_LENGTH ||
      !SUBJECT.test(sub)
    ) {
      throw new AuthFailure("subject_missing");
    }
    if (payload.typ !== ACCESS_TOKEN_TYPE) {
      throw new AuthFailure("type_refused");
    }
    // P5-03 (ADR 0063): sid is required; it names the session row.
    const { sid } = payload;
    if (
      typeof sid !== "string" ||
      sid.length === 0 ||
      sid.length > MAX_SUBJECT_LENGTH ||
      !SUBJECT.test(sid)
    ) {
      throw new AuthFailure("token_malformed");
    }
    return { subject: sub, orgHint: payload.org_id, sessionId: sid };
  }
}
