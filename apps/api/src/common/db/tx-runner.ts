// Opens withTx() as the current request's identity (P4-03, ADR 0053;
// ADR 0040: withTx() lives in @bricx/db, the api only wires it to the
// request context). Repositories receive the `tx` it hands over.
import { type Database, type Tx } from "@bricx/db/database";
import { Inject, Injectable } from "@nestjs/common";
import { DATABASE } from "./database.tokens.js";
import {
  NoRequestContextError,
  NoTenantContextError,
  currentRequestContext,
} from "./request-context.js";

@Injectable()
export class TxRunner {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  /**
   * Runs `fn` in one transaction as the request's org, user and projects.
   * Outside a request: NoRequestContextError; without an identity (not
   * authenticated): NoTenantContextError. Both before any connection.
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
    return this.database.withTx(
      {
        orgId: identity.orgId,
        userId: identity.userId,
        projectIds: identity.projectIds,
      },
      fn,
    );
  }
}
