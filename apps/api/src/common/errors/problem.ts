// problemFor(error): the one mapping from a thrown value to an envelope
// code and a log level (P4-07, ADR 0057, decision 3a; owner condition 3
// for COMMIT failures). Pure: no request, no logger. Everything unknown
// is 500 generic, logged with its stack; the client never sees a message.
import {
  DatabaseUnavailableError,
  TransactionCommitError,
  sqlstateOf,
} from "@bricx/db/database";
import { IdempotencyError } from "@bricx/db/idempotency";
import { ERROR_STATUS, type ErrorCode } from "@bricx/validation/codes";
import type { EnvelopeIssue } from "@bricx/validation/error-envelope";
import { HttpException } from "@nestjs/common";
import { NoTenantContextError } from "../db/request-context.js";
import { IdempotencyMisuseError } from "../idempotency/state.js";
import { ApiError, ValidationError } from "./api-error.js";

export interface Problem {
  readonly code: ErrorCode;
  /** info: the client's fault (4xx); error: ours (5xx), with the stack. */
  readonly log: "info" | "error";
  readonly issues?: readonly EnvelopeIssue[];
  readonly truncated?: true;
}

/**
 * node-postgres failures that carry no SQLSTATE: the socket (a system
 * errno code) or the client after its connection ended. The database, not
 * the request: 503 (for architect review).
 */
const CONNECTION_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENOTFOUND",
]);
const CONNECTION_MESSAGE =
  /^(?:Connection terminated|Client has encountered a connection error|Connection timed out|timeout expired|Query read timeout)/;
const MAX_CAUSE_DEPTH = 4;

/** Whether `error` or a cause of it is a connection-level driver failure. */
function isConnectionFailure(error: Error): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) return false;
    const code: unknown = Reflect.get(current, "code");
    if (typeof code === "string" && CONNECTION_CODES.has(code)) return true;
    if (CONNECTION_MESSAGE.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

/** SQLSTATEs that mean "retry or refresh", at COMMIT or inside fn. */
const RETRYABLE: ReadonlySet<string> = new Set(["40001", "40P01"]);
/** Constraint violations a client can resolve (owner condition 3). */
const COMMIT_CONFLICTS: ReadonlySet<string> = new Set([
  "23505",
  "23503",
  "23P01",
  ...RETRYABLE,
]);
/** Connection, resource and operator-intervention classes: the database, not the request. */
const UNAVAILABLE_CLASSES: ReadonlySet<string> = new Set(["08", "53", "57"]);

const problem = (code: ErrorCode): Problem => ({
  code,
  log: ERROR_STATUS[code] >= 500 ? "error" : "info",
});

/** The code for an HTTP status Nest or Fastify chose. */
function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return "request.malformed";
    case 401:
      return "session_expired";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "request.conflict";
    case 413:
      return "request.body_too_large";
    case 415:
      return "request.unsupported_media_type";
    case 422:
      return "validation_failed";
    case 429:
      return "rate_limited";
    case 502:
    case 503:
    case 504:
      return "server_unavailable";
    default:
      return "generic";
  }
}

/** A COMMIT that failed after the handler resolved (owner condition 3). */
function commitProblem(sqlstate: string | undefined): Problem {
  if (sqlstate === undefined) return problem("server_unavailable");
  if (COMMIT_CONFLICTS.has(sqlstate)) return problem("request.conflict");
  if (sqlstate.startsWith("23")) return problem("generic");
  return problem("server_unavailable");
}

/** A node-postgres error raised inside the handler (for architect review). */
function driverProblem(sqlstate: string): Problem {
  if (UNAVAILABLE_CLASSES.has(sqlstate.slice(0, 2))) {
    return problem("server_unavailable");
  }
  if (RETRYABLE.has(sqlstate)) return problem("request.conflict");
  return problem("generic");
}

export function problemFor(error: unknown): Problem {
  if (error instanceof ApiError) return problem(error.code);
  if (error instanceof ValidationError) {
    const { issues, truncated } = error.envelope;
    return {
      ...problem("validation_failed"),
      ...(issues === undefined ? {} : { issues }),
      ...(truncated === undefined ? {} : { truncated }),
    };
  }
  if (error instanceof IdempotencyError) {
    return problem(
      error.code === "response_too_large"
        ? "idempotency.response_too_large"
        : "generic",
    );
  }
  if (error instanceof IdempotencyMisuseError) return problem("generic");
  if (error instanceof NoTenantContextError) return problem("session_expired");
  if (error instanceof DatabaseUnavailableError) {
    return problem("server_unavailable");
  }
  if (error instanceof TransactionCommitError) {
    return commitProblem(error.sqlstate);
  }
  if (error instanceof HttpException)
    return problem(codeForStatus(error.getStatus()));
  if (error instanceof Error) {
    const statusCode: unknown = Reflect.get(error, "statusCode");
    const code: unknown = Reflect.get(error, "code");
    // Fastify's own errors (FST_ERR_CTP_*: bad JSON, body too large, media type).
    if (typeof statusCode === "number" && typeof code === "string") {
      return problem(codeForStatus(statusCode));
    }
    const sqlstate = sqlstateOf(error);
    if (sqlstate !== undefined) return driverProblem(sqlstate);
    if (isConnectionFailure(error)) return problem("server_unavailable");
  }
  return problem("generic");
}
