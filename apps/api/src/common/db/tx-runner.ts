// Opens withTx() as the current request's identity (P4-03, ADR 0053;
// ADR 0040: withTx() lives in @bricx/db, the api only wires it to the
// request context). Repositories receive the `tx` it hands over.
// P4-07 (ADR 0057): on an @Idempotent() route the transaction first
// claims (route, key); a live key replays the stored answer instead of
// running `fn` (422 idempotency.key_reused when the request differs);
// otherwise `fn` runs and its serialised result is stored before COMMIT.
import { type Database, type Tx } from "@bricx/db/database";
import {
  REPLAY_HEADERS,
  claimIdempotencyKey,
  storeIdempotencyResponse,
} from "@bricx/db/idempotency";
import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors/api-error.js";
import {
  IDEMPOTENCY_SLOT,
  type IdempotencyState,
  IdempotencyMisuseError,
} from "../idempotency/state.js";
import { DATABASE } from "./database.tokens.js";
import {
  NoRequestContextError,
  NoTenantContextError,
  currentRequestContext,
  requestSlot,
} from "./request-context.js";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

@Injectable()
export class TxRunner {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  /**
   * Runs `fn` in one transaction as the request's org, user and projects.
   * Outside a request: NoRequestContextError; without an identity (not
   * authenticated): NoTenantContextError. Both before any connection.
   * On an @Idempotent() route, once per request (a second call is
   * IdempotencyMisuseError): the claim is the transaction's first
   * statement; on a replay `fn` does not run and the stored body, parsed,
   * is returned in its place.
   */
  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const context = currentRequestContext();
    if (context === undefined) {
      return Promise.reject(new NoRequestContextError());
    }
    const { identity } = context;
    if (identity === undefined) {
      return Promise.reject(new NoTenantContextError());
    }
    const txContext = {
      orgId: identity.orgId,
      userId: identity.userId,
      projectIds: identity.projectIds,
    };
    // The slot is written by IdempotencyInterceptor alone, with this shape.
    const state = requestSlot(IDEMPOTENCY_SLOT) as IdempotencyState | undefined;
    if (state === undefined) return this.database.withTx(txContext, fn);
    if (state.runs > 0) {
      return Promise.reject(new IdempotencyMisuseError("second_run"));
    }
    state.runs += 1;
    return this.database.withTx(txContext, async (tx) => {
      const claim = await claimIdempotencyKey(tx, {
        route: state.route,
        key: state.key,
        requestHash: state.requestHash,
        status: state.status,
      });
      if (!claim.claimed) {
        if (!claim.stored.requestHash.equals(state.requestHash)) {
          throw new ApiError("idempotency.key_reused");
        }
        state.response = claim.stored;
        state.replayed = true;
        return JSON.parse(claim.stored.body) as T;
      }
      const result = await fn(tx);
      // JSON.stringify of undefined (no result) is undefined, whatever its
      // type says: such a handler stores "null".
      const text: unknown = JSON.stringify(result);
      const body = typeof text === "string" ? text : "null";
      const headers: Record<string, string> = {};
      for (const name of REPLAY_HEADERS) {
        const value = state.replyHeader(name);
        if (value !== undefined) headers[name] = value;
      }
      headers["content-type"] ??= JSON_CONTENT_TYPE;
      await storeIdempotencyResponse(tx, claim.id, body, headers);
      state.response = {
        requestHash: state.requestHash,
        status: state.status,
        body,
        headers,
      };
      return result;
    });
  }
}
