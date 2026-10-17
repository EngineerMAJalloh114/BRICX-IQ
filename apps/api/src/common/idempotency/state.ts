// The idempotency state of one request (P4-07, ADR 0057): what the
// interceptor validated before the handler, what TxRunner.run() learned
// (claimed and stored, or replayed), kept in a request-context slot.
import type { StoredResponse } from "@bricx/db/idempotency";
import type { WireForm } from "./wire.js";

export type IdempotencyMisuse = "second_run" | "no_run";

/**
 * An @Idempotent() handler opened TxRunner.run() twice (the second write
 * could not be covered by the key) or never (nothing to store). A
 * programming error: 500 generic.
 */
export class IdempotencyMisuseError extends Error {
  readonly reason: IdempotencyMisuse;

  constructor(reason: IdempotencyMisuse) {
    super(`idempotency misuse: ${reason}`);
    this.reason = reason;
  }
}
Object.defineProperty(IdempotencyMisuseError.prototype, "name", {
  value: "IdempotencyMisuseError",
});

export interface IdempotencyState {
  readonly key: string;
  readonly route: string;
  readonly requestHash: Buffer;
  /** The status the route answers with on success (@HttpCode or the default). */
  readonly status: number;
  /** A response header the handler set so far (location, etag). */
  readonly replyHeader: (name: string) => string | undefined;
  /**
   * The handler's response DTO, as the serializer applies it (P4-08,
   * ADR 0058, owner condition 1): the stored text is wire(result), what
   * the client receives; a replay hands unwire(stored) back to the
   * serializer, which encodes it to the same text.
   */
  readonly form: WireForm;
  /** How many times TxRunner.run() was opened. */
  runs: number;
  /** The answer sent: stored on the first run, read back on a replay. */
  response: StoredResponse | undefined;
  replayed: boolean;
}

/** The request-context slot the state lives in. */
export const IDEMPOTENCY_SLOT: unique symbol = Symbol("bricx.idempotency");
