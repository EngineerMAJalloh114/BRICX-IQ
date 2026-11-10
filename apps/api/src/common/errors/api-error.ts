// The errors a handler throws on purpose (P4-07, ADR 0057, decision 3a).
// ApiError(code) answers with a registered envelope code and its status;
// ValidationError(envelope) carries a validation_failed envelope built by
// @bricx/validation (ZodValidationPipe). Neither carries a message for the
// client: the filter renders the code, the key and the correlation id.
// P6-05d (ADR 0080): an ApiError may carry Retry-After (whole seconds),
// which the filter sends as a header (429 rate_limited, 503 from the
// rate limiter's fail-closed classes).
import { ERROR_STATUS, type ErrorCode } from "@bricx/validation/codes";
import type { ErrorEnvelope } from "@bricx/validation/error-envelope";

export interface ApiErrorOptions {
  /** Seconds the client should wait: the Retry-After header. */
  readonly retryAfterSeconds?: number;
  /**
   * The resource the conflict is about, as an API path (P6-06, ADR 0077,
   * D12: the pending invitation a duplicate names): the Location header.
   * The body never changes.
   */
  readonly location?: string;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly retryAfterSeconds: number | undefined;
  readonly location: string | undefined;

  constructor(code: ErrorCode, options: ApiErrorOptions = {}) {
    super(`api error: ${code}`);
    this.code = code;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.location = options.location;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}
Object.defineProperty(ApiError.prototype, "name", { value: "ApiError" });

/** A request body or query that failed its boundary schema (422). */
export class ValidationError extends Error {
  readonly envelope: ErrorEnvelope;

  constructor(envelope: ErrorEnvelope) {
    super("validation failed");
    this.envelope = envelope;
  }
}
Object.defineProperty(ValidationError.prototype, "name", {
  value: "ValidationError",
});
