// The error serializer of every service logger (P5-02 commit 1, P4 point
// 23, ADR 0062). pino's default `err` serializer copies every enumerable
// field, which for a database error means node-postgres' `detail`
// (Key (k)=(<value>)), `where`, `internalQuery` and a message that can
// quote input (invalid input syntax for type uuid: "<value>"), and
// Drizzle's wrapper adds the query text and its parameters. So:
// - an error with a database error anywhere in its cause chain (a
//   SQLSTATE, Drizzle's DrizzleQueryError, TransactionCommitError) is
//   logged as its type, the SQLSTATE, the constraint, schema, table and
//   column names, and its stack frames: no message, no cause, no fields;
// - any other Error keeps its type, message, stack and cause chain
//   (bounded), and nothing else: code must not put values into messages;
// - a value that is not an Error is logged by its type only.
import { DrizzleQueryError } from "drizzle-orm/errors";

export interface LoggedError {
  readonly type: string;
  readonly message?: string;
  readonly stack?: string;
  readonly sqlstate?: string;
  readonly constraint?: string;
  readonly schema?: string;
  readonly table?: string;
  readonly column?: string;
  readonly cause?: LoggedError;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;
/** A Postgres identifier as the driver reports it (no quoting needed). */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const MAX_DEPTH = 5;
const MAX_MESSAGE = 1_000;
const MAX_STACK = 4_000;
const IDENTIFIER_FIELDS = ["constraint", "schema", "table", "column"] as const;

function typeOf(error: Error): string {
  if (error instanceof DrizzleQueryError) return "DrizzleQueryError";
  return error.name;
}

function sqlstateIn(error: Error): string | undefined {
  const code: unknown = Reflect.get(error, "code");
  if (typeof code === "string" && SQLSTATE.test(code)) return code;
  const sqlstate: unknown = Reflect.get(error, "sqlstate");
  if (typeof sqlstate === "string" && SQLSTATE.test(sqlstate)) return sqlstate;
  return undefined;
}

/** The chain from `error` through `cause`, Errors only, bounded. */
function chainOf(error: Error): Error[] {
  const chain: Error[] = [];
  let current: unknown = error;
  while (current instanceof Error && chain.length < MAX_DEPTH) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

const isDatabaseError = (error: Error): boolean =>
  error instanceof DrizzleQueryError ||
  error.name === "TransactionCommitError" ||
  sqlstateIn(error) !== undefined;

/** The stack's frames only: the message lines are dropped. */
function framesOf(stack: unknown): string | undefined {
  if (typeof stack !== "string") return undefined;
  const frames = stack
    .split("\n")
    .filter((line) => /^\s+at /.test(line))
    .join("\n");
  return frames === "" ? undefined : frames.slice(0, MAX_STACK);
}

type Identifiers = Partial<Record<(typeof IDENTIFIER_FIELDS)[number], string>>;

function identifiersOf(link: Error): Identifiers {
  const out: Identifiers = {};
  for (const field of IDENTIFIER_FIELDS) {
    const value: unknown = Reflect.get(link, field);
    if (typeof value === "string" && IDENTIFIER.test(value)) {
      out[field] = value;
    }
  }
  return out;
}

function databaseForm(error: Error, chain: Error[]): LoggedError {
  const link = chain.find((candidate) => sqlstateIn(candidate) !== undefined);
  const sqlstate = link === undefined ? undefined : sqlstateIn(link);
  const frames = framesOf(error.stack);
  return {
    type: typeOf(error),
    ...(sqlstate === undefined ? {} : { sqlstate }),
    ...(link === undefined ? {} : identifiersOf(link)),
    ...(frames === undefined ? {} : { stack: frames }),
  };
}

function ordinaryForm(error: Error, depth: number): LoggedError {
  const cause =
    error.cause instanceof Error && depth + 1 < MAX_DEPTH
      ? ordinaryForm(error.cause, depth + 1)
      : undefined;
  return {
    type: typeOf(error),
    message: error.message.slice(0, MAX_MESSAGE),
    ...(typeof error.stack === "string"
      ? { stack: error.stack.slice(0, MAX_STACK) }
      : {}),
    ...(cause === undefined ? {} : { cause }),
  };
}

/** What a logger writes for `value` under `err` or `error`. */
export function serializeError(value: unknown): LoggedError {
  if (!(value instanceof Error)) {
    return { type: value === null ? "null" : typeof value };
  }
  const chain = chainOf(value);
  if (chain.some(isDatabaseError)) return databaseForm(value, chain);
  return ordinaryForm(value, 0);
}

/** pino `serializers` for the two keys errors are logged under. */
export const errorSerializers = Object.freeze({
  err: serializeError,
  error: serializeError,
});
