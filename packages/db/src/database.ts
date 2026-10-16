// The database handle (ADR 0040: the Postgres pool lives only in this
// package). P4-01: a readiness ping and a clean shutdown. P4-03 (ADR 0053):
// withTx(), the only way to run SQL on the pool. P4-06 (ADR 0056):
// openRelayDatabase() and withRelayTx(), the outbox relay's bricx_relay
// transaction: a documented exception to CLAUDE.md rule 4 (no tenant
// context), allowed by Semgrep only in apps/worker/src/relay/. The pool
// itself is never exported. P4-07 (ADR 0057): a failure after `fn`
// resolved (at COMMIT) is TransactionCommitError with the SQLSTATE only,
// and every pooled client carries an error listener, so a connection lost
// under a transaction fails that transaction instead of the process.
import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
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
   * an error from `fn` rolls back and is rethrown unchanged; a failure
   * after `fn` resolved (COMMIT refused: a deferred constraint, a
   * serialisation failure, a lost connection) is TransactionCommitError
   * carrying the SQLSTATE only (P4-07, ADR 0057).
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

const SQLSTATE = /^[0-9A-Z]{5}$/;
/** How deep sqlstateOf() follows `cause` (Drizzle wraps the driver's error once). */
const MAX_CAUSE_DEPTH = 4;

/**
 * The 5-character SQLSTATE of a driver error, following `cause` (Drizzle
 * wraps node-postgres errors in its own, with the driver's as the cause),
 * or undefined when none in the chain carries one.
 */
export function sqlstateOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) return undefined;
    const code: unknown = Reflect.get(current, "code");
    if (typeof code === "string" && SQLSTATE.test(code)) return code;
    current = current.cause;
  }
  return undefined;
}

/**
 * COMMIT failed after the callback resolved. Nothing was written. Carries
 * the 5-character SQLSTATE when the driver reported one (23505, 40001,
 * 57014...) and nothing else: no message, no cause, no query text.
 */
export class TransactionCommitError extends Error {
  readonly sqlstate: string | undefined;

  constructor(sqlstate?: unknown) {
    super("transaction commit failed");
    this.sqlstate =
      typeof sqlstate === "string" && SQLSTATE.test(sqlstate)
        ? sqlstate
        : undefined;
  }
}
Object.defineProperty(TransactionCommitError.prototype, "name", {
  value: "TransactionCommitError",
});

/** Adds an error listener to every client the pool opens (see below). */
function keepClientsQuiet(pool: pg.Pool): void {
  // An idle client that loses its connection emits on the pool; without a
  // listener Node would crash the process. The next ping reports it.
  pool.on("error", () => undefined);
  // pg-pool listens for errors only on idle clients. A connection lost
  // while a client is checked out (terminated, network cut) would
  // otherwise emit an unhandled "error" and crash the process; with this
  // listener the next statement fails, the transaction rejects and the
  // pool discards the client (P4-06 done when 2; the API from P4-07).
  pool.on("connect", (client) => {
    client.on("error", () => undefined);
  });
}

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
  keepClientsQuiet(pool);
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
      const progress = { contextSet: false, fnDone: false };
      try {
        return await inTransaction.run(true, () =>
          orm.transaction(async (tx) => {
            await tx.execute(setContext);
            progress.contextSet = true;
            const result = await fn(tx);
            progress.fnDone = true;
            return result;
          }),
        );
      } catch (error) {
        if (!progress.contextSet) throw new DatabaseUnavailableError();
        // fn resolved, so this is the COMMIT (or its rollback) failing.
        if (progress.fnDone)
          throw new TransactionCommitError(sqlstateOf(error));
        throw error;
      }
    },
    close() {
      closed ??= pool.end();
      return closed;
    },
  };
}

/** The role withRelayTx() must run as (ADR 0056). */
export const RELAY_ROLE = "bricx_relay";

/**
 * withRelayTx() on a connection that is not bricx_relay: a wrong URL must
 * never run the relay's cross-org statements as another role.
 */
export class RelayRoleError extends Error {
  constructor() {
    super("relay transaction: not bricx_relay");
  }
}
Object.defineProperty(RelayRoleError.prototype, "name", {
  value: "RelayRoleError",
});

/** The outbox relay's database handle (bricx_relay; ADR 0056). */
export interface RelayDatabase {
  /** Resolves when Postgres answers `SELECT 1` within the bound. */
  ping(): Promise<void>;
  /**
   * Runs `fn` in one transaction after checking current_user is
   * bricx_relay (RelayRoleError otherwise, and `fn` never runs) and setting
   * a transaction-local statement_timeout (default 30 s). No tenant
   * context is set: bricx_relay's policies on bricx.outbox are TO
   * bricx_relay USING (true), and it can reach no other table. Nesting
   * (in itself or in withTx()) is NestedTransactionError; a failure to
   * connect is DatabaseUnavailableError (no detail).
   */
  withRelayTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Closes every connection; the handle cannot be used afterwards. */
  close(): Promise<void>;
}

/**
 * Opens a lazy pool for the relay's `url` (RELAY_DATABASE_URL). The secret
 * is revealed here and nowhere else.
 */
export function openRelayDatabase(
  url: SecretUrl,
  options: DatabaseOptions = {},
): RelayDatabase {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const statementTimeoutMs =
    options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  const pool = new pg.Pool({
    connectionString: url.reveal(),
    max: options.maxConnections ?? 2,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: options.queryTimeoutMs ?? statementTimeoutMs + timeoutMs,
  });
  keepClientsQuiet(pool);
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
    async withRelayTx<T>(fn: (tx: Tx) => Promise<T>) {
      if (inTransaction.getStore() === true) {
        throw new NestedTransactionError();
      }
      if (closed !== undefined) throw new DatabaseUnavailableError();
      const progress = { started: false };
      try {
        return await inTransaction.run(true, () =>
          orm.transaction(async (tx) => {
            const who = await tx.execute<{ role: string }>(
              sql`SELECT current_user AS role,
                         set_config('statement_timeout', ${String(statementTimeoutMs)}, true)`,
            );
            progress.started = true;
            if (who.rows[0]?.role !== RELAY_ROLE) throw new RelayRoleError();
            return fn(tx);
          }),
        );
      } catch (error) {
        if (!progress.started) throw new DatabaseUnavailableError();
        throw error;
      }
    },
    close() {
      closed ??= pool.end();
      return closed;
    },
  };
}
