// @Idempotent() (P4-07, ADR 0057, decision 6a): the route requires an
// Idempotency-Key header, claims (route, key) as the first statement of
// its TxRunner.run() transaction, stores the serialised response in the
// same transaction, and replays it verbatim for 24 h. POSTs that create
// money or stock movements carry it (P9-04, P11-03).
import { SetMetadata } from "@nestjs/common";

export const IDEMPOTENT_METADATA = "bricx:idempotent";
/** The request header (RFC draft-ietf-httpapi-idempotency-key-header). */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
/** Set to "true" on a replayed response, never on the first. */
export const REPLAYED_HEADER = "idempotent-replayed";

export const Idempotent = (): MethodDecorator =>
  SetMetadata(IDEMPOTENT_METADATA, true);
