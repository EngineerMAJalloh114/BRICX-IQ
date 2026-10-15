// The database handle (ADR 0040: the Postgres pool lives only in this
// package). P4-01: a readiness ping and a clean shutdown. P4-03 (ADR 0053):
// withTx(), the only way to run SQL on the pool. The pool itself is never
// exported.
import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import {
  DEFAULT_STATEMENT_TIMEOUT_MS,
  NestedTransactionError,
  type Tx,
  type TxContext,
  contextStatement,
  validateTxContext,
} from "./tx.js";

export {
  DEFAULT_STATEMENT_TIMEOUT_MS,
  InvalidTxContextError,
  MAX_PROJECT_IDS,
  NestedTransactionError,
  type Tx,
  type TxContext,
  type TxContextField,
  validateTxContext,
} from "./tx.js";

/** A secret connection string (@bricx/config's Secret satisfies it). */
export interface SecretUrl {
  reveal(): string;
}

export interface DatabaseOptions {
  /** Bound on connecting, in milliseconds (default 2 s). */
  readonly timeoutMs?: number;
  /**
   * Client-side bound on each query's answer, in milliseconds (default:
   * timeoutMs). A pool that runs withTx() sets it above
   * statementTimeoutMs, so Postgres cancels a slow statement first.
   */
  readonly queryTimeoutMs?: number;
  /** Server-side statement_timeout inside withTx(), in ms (default 30 s). */
  readonly statementTimeoutMs?: number;
  /** Most connections the pool opens. */
  readonly maxConnections?: number;
}

export interface Database {
  /** Resolves when Postgres answers `SELECT 1` within the bound. */
  ping(): Promise<void>;
  /**
   * Runs `fn` in one transaction as the pool's role (bricx_app), after
   * `set_config(..., true)` of app.org_id, app.user_id, app.project_ids
   * and statement_timeout (transaction-local, so nothing outlives it).
   * The context is validated and copied at the call; an invalid one is
   * InvalidTxContextError before any connection is used. withTx() inside
   * withTx() is NestedTransactionError. A failure to connect or to set the
   * context is DatabaseUnavailableError (no detail) and `fn` never runs;
   * an error from `fn` rolls back and is rethrown unchanged.
   */
  withTx<T>(context: TxContext, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Closes every connection; the handle cannot be used afterwards. */
  close(): Promise<void>;
}

/**
 * Thrown when Postgres cannot be reached or does not answer in time. It
 * carries no cause and no detail: driver errors can quote the host, the
 * user or the query, and this message reaches logs and health responses.
 */
export class DatabaseUnavailableError extends Error {
  constructor() {
    super("database unavailable");
  }
}
Object.defineProperty(DatabaseUnavailableError.prototype, "name", {
  value: "DatabaseUnavailableError",
});

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_CONNECTIONS = 10;

/** Set while a withTx() callback runs, to refuse a nested withTx(). */
const inTransaction = new AsyncLocalStorage<true>();

/**
 * Opens a lazy pool for `url`. The secret is revealed here and nowhere
 * else; the pool connects on first use.
 */
export function openDatabase(
  url: SecretUrl,
  options: DatabaseOptions = {},
): Database {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const statementTimeoutMs =
    options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  const pool = new pg.Pool({
    connectionString: url.reveal(),
    max: options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: options.queryTimeoutMs ?? timeoutMs,
  });
  // An idle client that loses its connection emits on the pool; without a
  // listener Node would crash the process. The next ping reports it.
  pool.on("error", () => undefined);
  const orm = drizzle({ client: pool });
  let closed: Promise<void> | undefined;
  return {
    async ping() {
      if (closed !== undefined) throw new DatabaseUnavailableError();
      try {
        await pool.query("SELECT 1");
      } catch {
        throw new DatabaseUnavailableError();
      }
    },
    async withTx<T>(context: TxContext, fn: (tx: Tx) => Promise<T>) {
      // Synchronous up to here: the copy is taken at the call.
      const ctx = validateTxContext(context);
      if (inTransaction.getStore() === true) {
        throw new NestedTransactionError();
      }
      if (closed !== undefined) throw new DatabaseUnavailableError();
      const setContext = contextStatement(ctx, statementTimeoutMs);
      // Set inside the callback; read after it, so not a narrowable local.
      const progress = { contextSet: false };
      try {
        return await inTransaction.run(true, () =>
          orm.transaction(async (tx) => {
            await tx.execute(setContext);
            progress.contextSet = true;
            return fn(tx);
          }),
        );
      } catch (error) {
        if (!progress.contextSet) throw new DatabaseUnavailableError();
        throw error;
      }
    },
    close() {
      closed ??= pool.end();
      return closed;
    },
  };
}
