// @Idempotent() (P4-07, ADR 0057, decision 6a): the route requires an
// Idempotency-Key header, claims (route, key) as the first statement of
// its TxRunner.run() transaction, stores the serialised response in the
// same transaction, and replays it verbatim for 24 h. POSTs that create
// money or stock movements carry it (P9-04, P11-03). P4-08 (ADR 0058):
// the route is also marked in the OpenAPI document (x-bricx-idempotent),
// which the document post-processing turns into the required
// Idempotency-Key header parameter and the Idempotent-Replayed header.
import { SetMetadata, applyDecorators } from "@nestjs/common";
import { IdempotentExtension } from "../../openapi/extensions.js";

export const IDEMPOTENT_METADATA = "bricx:idempotent";
/** The request header (RFC draft-ietf-httpapi-idempotency-key-header). */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
/** Set to "true" on a replayed response, never on the first. */
export const REPLAYED_HEADER = "idempotent-replayed";

export const Idempotent = (): MethodDecorator =>
  applyDecorators(
    SetMetadata(IDEMPOTENT_METADATA, true),
    IdempotentExtension(),
  );
