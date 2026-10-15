// The database handle (ADR 0040: the Postgres pool lives only in this
// package). P4-01 needs a readiness ping and a clean shutdown; P4-03 adds
// withTx() here, and the pool itself is never exported.
import pg from "pg";

/** A secret connection string (@bricx/config's Secret satisfies it). */
export interface SecretUrl {
  reveal(): string;
}

export interface DatabaseOptions {
  /** Bound on connecting and on each ping query, in milliseconds. */
  readonly timeoutMs?: number;
  /** Most connections the pool opens. */
  readonly maxConnections?: number;
}

export interface Database {
  /** Resolves when Postgres answers `SELECT 1` within the bound. */
  ping(): Promise<void>;
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

/**
 * Opens a lazy pool for `url`. The secret is revealed here and nowhere
 * else; the pool connects on first use.
 */
export function openDatabase(
  url: SecretUrl,
  options: DatabaseOptions = {},
): Database {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pool = new pg.Pool({
    connectionString: url.reveal(),
    max: options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
  });
  // An idle client that loses its connection emits on the pool; without a
  // listener Node would crash the process. The next ping reports it.
  pool.on("error", () => undefined);
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
    close() {
      closed ??= pool.end();
      return closed;
    },
  };
}
