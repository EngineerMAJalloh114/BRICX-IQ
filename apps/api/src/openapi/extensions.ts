// OpenAPI vendor extensions the document post-processing reads (P4-08,
// ADR 0058, decision 2a). They stay in the published document: a client
// generator can read them too.
import { ApiExtension } from "@nestjs/swagger";

/** On an @Idempotent() operation: the Idempotency-Key header is required. */
export const IDEMPOTENT_EXTENSION = "x-bricx-idempotent";
/**
 * On an operation whose errors are not problem+json: the health routes
 * keep terminus's body (HealthExceptionFilter), so they get no `default`
 * ErrorEnvelope response.
 */
export const PLAIN_ERRORS_EXTENSION = "x-bricx-plain-errors";

export const IdempotentExtension = () =>
  ApiExtension(IDEMPOTENT_EXTENSION, true);
export const PlainErrors = () => ApiExtension(PLAIN_ERRORS_EXTENSION, true);
