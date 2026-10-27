// The segregation-of-duties history (P5-07, ADR 0068; owner D-A and
// condition 2): bricx.sod_actions, read and written inside the API's
// withTx() as bricx_app in the record's org.
// - lockSodChain(tx, chainId): the chain's advisory lock (held until
//   COMMIT), the same (SOD_LOCK_NAMESPACE, hashtext(chain_id)) the
//   generated trigger bricx.sod_conflict() takes, so a check and its
//   insert are not raced by another transaction on the same chain.
// - sodHistory(tx, chainId): the chain's rows as checkSod's entries,
//   oldest first, at most LIMITS.sodHistory + 1 (one more than checkSod
//   accepts, so an overflow reaches it as too_many_history).
// - recordSodAction(tx, row): one row in the caller's transaction; the
//   trigger's refusal (23514, constraint sod_actions_segregation) comes
//   back as SodError("sod_violation").
// Ids are checked before any SQL; an error never carries a value.
import { SOD_LOCK_NAMESPACE } from "@bricx/permissions/generate";
import { LIMITS } from "@bricx/permissions/limits";
import { sql } from "drizzle-orm";
import { sqlstateOf } from "./database.js";
import type { Tx } from "./tx.js";

export type SodErrorCode =
  "invalid_id" | "invalid_entry" | "invalid_result" | "sod_violation";

export class SodError extends Error {
  readonly code: SodErrorCode;

  constructor(code: SodErrorCode) {
    super(`sod: ${code}`);
    this.code = code;
  }
}
Object.defineProperty(SodError.prototype, "name", { value: "SodError" });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECORD_TYPE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const ACTION = /^[a-z][a-z0-9_]*$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CHECK_VIOLATION = "23514";
const SEGREGATION = "sod_actions_segregation";

const checkId = (id: unknown): string => {
  if (typeof id !== "string" || !UUID.test(id)) {
    throw new SodError("invalid_id");
  }
  return id;
};

/** One action taken on a chain, as checkSod reads it. */
export interface SodEntry {
  readonly chainId: string;
  readonly recordId: string;
  readonly recordType: string;
  readonly action: string;
  readonly actorId: string;
}

/** A row recordSodAction() writes. */
export interface SodActionRow extends SodEntry {
  /** The record's project, or null for an org-level record. */
  readonly projectId: string | null;
  /** From the injected Clock, toISOString() form. */
  readonly at: string;
}

/** Takes the chain's advisory lock until the transaction ends. */
export async function lockSodChain(tx: Tx, chainId: string): Promise<void> {
  const chain = checkId(chainId);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${SOD_LOCK_NAMESPACE}::integer, hashtext(${chain}::uuid::text))`,
  );
}

/** The chain's history in this org, oldest first, at most LIMITS.sodHistory + 1. */
export async function sodHistory(tx: Tx, chainId: string): Promise<SodEntry[]> {
  const chain = checkId(chainId);
  const result = await tx.execute<{
    chain_id: unknown;
    record_id: unknown;
    record_type: unknown;
    action: unknown;
    actor_id: unknown;
  }>(
    sql`SELECT chain_id::text, record_id::text, record_type, action, actor_id::text
        FROM bricx.sod_actions
        WHERE org_id = app.current_org() AND chain_id = ${chain}::uuid
        ORDER BY id
        LIMIT ${LIMITS.sodHistory + 1}`,
  );
  return result.rows.map((r) => {
    if (
      typeof r.chain_id !== "string" ||
      typeof r.record_id !== "string" ||
      typeof r.record_type !== "string" ||
      typeof r.action !== "string" ||
      typeof r.actor_id !== "string"
    ) {
      throw new SodError("invalid_result");
    }
    return {
      chainId: r.chain_id,
      recordId: r.record_id,
      recordType: r.record_type,
      action: r.action,
      actorId: r.actor_id,
    };
  });
}

/** Writes one action in the caller's transaction (org = the transaction's org). */
export async function recordSodAction(
  tx: Tx,
  row: SodActionRow,
): Promise<void> {
  const chain = checkId(row.chainId);
  const record = checkId(row.recordId);
  const actor = checkId(row.actorId);
  const project = row.projectId === null ? null : checkId(row.projectId);
  if (
    typeof row.recordType !== "string" ||
    !RECORD_TYPE.test(row.recordType) ||
    row.recordType.length > 64 ||
    typeof row.action !== "string" ||
    !ACTION.test(row.action) ||
    row.action.length > 64 ||
    typeof row.at !== "string" ||
    !INSTANT.test(row.at)
  ) {
    throw new SodError("invalid_entry");
  }
  try {
    await tx.execute(
      sql`INSERT INTO bricx.sod_actions
            (org_id, chain_id, record_id, record_type, action, actor_id, project_id, created_at)
          VALUES (app.current_org(), ${chain}::uuid, ${record}::uuid, ${row.recordType},
                  ${row.action}, ${actor}::uuid, ${project}::uuid, ${row.at}::timestamptz)`,
    );
  } catch (error) {
    if (
      sqlstateOf(error) === CHECK_VIOLATION &&
      constraintOf(error) === SEGREGATION
    ) {
      throw new SodError("sod_violation");
    }
    throw error;
  }
}

/** The constraint name on the driver error or a cause of it (drizzle wraps it). */
function constraintOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!(current instanceof Error)) return undefined;
    const constraint: unknown = Reflect.get(current, "constraint");
    if (typeof constraint === "string") return constraint;
    current = current.cause;
  }
  return undefined;
}
