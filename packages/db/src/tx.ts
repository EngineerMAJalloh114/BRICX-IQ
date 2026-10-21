// The transaction context (P4-03, ADR 0053): what withTx() sets for RLS
// (app.org_id, app.user_id, app.project_ids; ADR 0003). It is validated and
// copied before any connection is used, so a bad or later-mutated value can
// never reach Postgres. Errors name the field, never the value.
import { type SQL, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * What a transaction runs as. Every id is a canonical lower-case UUID.
 * `allProjects` (P5-05, owner condition 2, ADR 0066; amends ADR 0054):
 * every project of the org, as app.project_ids = '*'. Only this typed
 * option sets it, with an empty projectIds; DbGrantsSource is its one
 * producer (an org-scoped grant on a project-level resource), never a
 * token claim or a header. '*' is never accepted inside projectIds.
 */
export interface TxContext {
  readonly orgId: string;
  readonly userId: string;
  readonly projectIds: readonly string[];
  readonly allProjects?: boolean;
}

/** The transaction withTx() hands to its callback (Drizzle, node-postgres). */
export type Tx = Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];

/**
 * Most project ids one context may carry (bounds the work before any
 * validation; for architect review).
 */
export const MAX_PROJECT_IDS = 1000;

/** Default server-side bound on each statement in withTx(), in ms. */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

// Any version: user ids come from Keycloak (v4), the rest are UUIDv7.
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type TxContextField =
  "context" | "orgId" | "userId" | "projectIds" | "allProjects";

export class InvalidTxContextError extends Error {
  readonly field: TxContextField;

  constructor(field: TxContextField) {
    super(`invalid transaction context: ${field}`);
    this.field = field;
  }
}
Object.defineProperty(InvalidTxContextError.prototype, "name", {
  value: "InvalidTxContextError",
});

/** withTx() inside withTx(): use the transaction you already have. */
export class NestedTransactionError extends Error {
  constructor() {
    super("withTx() called inside another withTx()");
  }
}
Object.defineProperty(NestedTransactionError.prototype, "name", {
  value: "NestedTransactionError",
});

const isUuid = (value: unknown): value is string =>
  typeof value === "string" && CANONICAL_UUID.test(value);

/**
 * A frozen copy of `input` with exactly orgId, userId and projectIds
 * (plus allProjects: true when set), or InvalidTxContextError naming the
 * first bad field.
 */
export function validateTxContext(input: unknown): TxContext {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new InvalidTxContextError("context");
  }
  const orgId: unknown = Reflect.get(input, "orgId");
  if (!isUuid(orgId)) throw new InvalidTxContextError("orgId");
  const userId: unknown = Reflect.get(input, "userId");
  if (!isUuid(userId)) throw new InvalidTxContextError("userId");
  const projectIds: unknown = Reflect.get(input, "projectIds");
  if (!Array.isArray(projectIds) || projectIds.length > MAX_PROJECT_IDS) {
    throw new InvalidTxContextError("projectIds");
  }
  const allProjects: unknown = Reflect.get(input, "allProjects");
  if (allProjects !== undefined && typeof allProjects !== "boolean") {
    throw new InvalidTxContextError("allProjects");
  }
  if (allProjects === true && projectIds.length > 0) {
    throw new InvalidTxContextError("projectIds");
  }
  const copy: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < projectIds.length; i += 1) {
    const id: unknown = projectIds[i];
    if (!isUuid(id) || seen.has(id)) {
      throw new InvalidTxContextError("projectIds");
    }
    seen.add(id);
    copy.push(id);
  }
  return Object.freeze({
    orgId,
    userId,
    projectIds: Object.freeze(copy),
    ...(allProjects === true ? { allProjects: true } : {}),
  });
}

/** One set_config(name, value, true) call. */
export type Setting = readonly [name: string, value: string];

/**
 * The settings withTx() applies with set_config(name, value, true), in
 * order. app.project_ids is a Postgres array literal, so P4-04's
 * app.has_project() can read it as uuid[], or '*' for allProjects (P5-05:
 * has_project() answers true for every project). Values go to Postgres
 * as bind parameters, never in the SQL text.
 */
export function contextSettings(
  ctx: TxContext,
  statementTimeoutMs: number,
): readonly [Setting, Setting, Setting, Setting] {
  return [
    ["app.org_id", ctx.orgId],
    ["app.user_id", ctx.userId],
    [
      "app.project_ids",
      ctx.allProjects === true ? "*" : `{${ctx.projectIds.join(",")}}`,
    ],
    ["statement_timeout", String(statementTimeoutMs)],
  ];
}

/**
 * The one statement withTx() runs first: set_config(name, value, true)
 * for each of contextSettings(), so every value is transaction-local and
 * a bind parameter.
 */
export function contextStatement(
  ctx: TxContext,
  statementTimeoutMs: number,
): SQL {
  const [org, user, projects, timeout] = contextSettings(
    ctx,
    statementTimeoutMs,
  );
  return sql`SELECT set_config(${org[0]}, ${org[1]}, true),
                    set_config(${user[0]}, ${user[1]}, true),
                    set_config(${projects[0]}, ${projects[1]}, true),
                    set_config(${timeout[0]}, ${timeout[1]}, true)`;
}
