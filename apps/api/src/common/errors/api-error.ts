// The errors a handler throws on purpose (P4-07, ADR 0057, decision 3a).
// ApiError(code) answers with a registered envelope code and its status;
// ValidationError(envelope) carries a validation_failed envelope built by
// @bricx/validation (ZodValidationPipe). Neither carries a message for the
// client: the filter renders the code, the key and the correlation id.
import { ERROR_STATUS, type ErrorCode } from "@bricx/validation/codes";
import type { ErrorEnvelope } from "@bricx/validation/error-envelope";

export class ApiError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super(`api error: ${code}`);
    this.code = code;
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
