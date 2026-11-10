// Opens withTx() as the current request's identity (P4-03, ADR 0053;
// ADR 0040: withTx() lives in @bricx/db, the api only wires it to the
// request context). Repositories receive the `tx` it hands over.
// P4-07 (ADR 0057): on an @Idempotent() route the transaction first
// claims (route, key); a live key replays the stored answer instead of
// running `fn` (422 idempotency.key_reused when the request differs);
// otherwise `fn` runs and its serialised result is stored before COMMIT.
// P4-08 (ADR 0058, owner condition 1): what is stored is the WIRE form of
// the result (state.form.wire: the response DTO's encoding, a Money as
// { amount: "<minor>", currency }), and a replay returns the stored JSON
// decoded back (state.form.unwire) for the serializer to encode again.
// P6-02 (ADR 0072, D11, D12): runSignedIn() is the one transaction a
// @SignedIn() route opens: as the signed-in user the AuthGuard kept, in the
// org the caller names (the organisation being created: RLS then admits
// that organisation's rows and the user's own attempts only).
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
import { signedInUser } from "../auth/signed-in.decorator.js";
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
  /**
   * On a @SignedIn() route: one transaction as the signed-in user in
   * `orgId` (a lowercase UUIDv7, withTx() checks it), no project ids
   * unless `projectIds` names some (P6-06, ADR 0077: accepting a project
   * invitation writes that one project's membership; never the wildcard).
   * Outside a request: NoRequestContextError; without a signed-in user:
   * NoTenantContextError. Both before any connection.
   */
  runSignedIn<T>(
    orgId: string,
    fn: (tx: Tx) => Promise<T>,
    projectIds: readonly string[] = [],
  ): Promise<T> {
    if (currentRequestContext() === undefined) {
      return Promise.reject(new NoRequestContextError());
    }
    const user = signedInUser();
    if (user === undefined) return Promise.reject(new NoTenantContextError());
    return this.database.withTx(
      { orgId, userId: user.userId, projectIds: [...projectIds] },
      fn,
    );
  }

  /**
   * On a @Public() route (P6-06, ADR 0077, D6: invitation activation):
   * one transaction in `orgId` as `userId`, both found by the caller
   * through a SECURITY DEFINER lookup (the invitation's org and its
   * inviter), never taken from the request. No project ids. Outside a
   * request: NoRequestContextError, before any connection.
   */
  runAs<T>(
    context: { readonly orgId: string; readonly userId: string },
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    if (currentRequestContext() === undefined) {
      return Promise.reject(new NoRequestContextError());
    }
    return this.database.withTx(
      { orgId: context.orgId, userId: context.userId, projectIds: [] },
      fn,
    );
  }

  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const context = currentRequestContext();
    if (context === undefined) {
      return Promise.reject(new NoRequestContextError());
    }
    const { identity } = context;
    if (identity === undefined) {
      return Promise.reject(new NoTenantContextError());
    }
    // P5-05 (ADR 0066, owner condition 2): the wildcard travels as the
    // typed option, never as a project id.
    const txContext = {
      orgId: identity.orgId,
      userId: identity.userId,
      projectIds: identity.projectIds,
      allProjects: identity.allProjects,
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
        // The stored text was built from a T by state.form.wire; unwire
        // gives the handler-shaped value back (the type is not checked).
        return state.form.unwire(JSON.parse(claim.stored.body)) as T;
      }
      const result = await fn(tx);
      // JSON.stringify of undefined (no result) is undefined, whatever its
      // type says: such a handler stores "null". A bigint without a DTO
      // throws here: 500 generic, nothing stored.
      const text: unknown = JSON.stringify(state.form.wire(result));
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
