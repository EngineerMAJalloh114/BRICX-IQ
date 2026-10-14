// Segregation of duties (ROADMAP P3-05 step 4; CLAUDE.md rule 10; architect
// rulings 5 and 6; ADR 0048). A pair is two actions one actor may not both
// perform on the same record chain. The chain is identified by chainId, the
// originating record: the PO for its goods receipts, the payment for its
// reconciliation, the record itself for request/approve. checkSod is a pure
// function of the attempt and the chain's history; the API (P5-07) loads
// the history and calls it on the server. There is no override for anyone,
// owners included (the one-member organisation case is a pending decision,
// docs/adr/pending.md).
import { isUserId } from "@bricx/ids/branded";
import type { UserId } from "@bricx/ids/branded";
import { isUuidV7 } from "@bricx/ids/uuid-v7";
import { isSubjectType, scopesOf } from "./catalogue.ts";
import type { Action, SubjectType } from "./catalogue.ts";
import { PermissionError, SOD_VIOLATION_KEY } from "./errors.ts";
import { LIMITS } from "./limits.ts";
import { SOD_RULES } from "./sod-rules.ts";

export { SOD_RULES } from "./sod-rules.ts";
export type { SodRule } from "./sod-rules.ts";

/** One action already taken on the chain. */
export interface SodHistoryEntry {
  readonly chainId: string;
  readonly recordId: string;
  readonly recordType: SubjectType;
  readonly action: Action;
  readonly actorId: UserId;
}

/** The action about to be taken, with the chain's history. */
export interface SodAttempt extends SodHistoryEntry {
  readonly history: readonly SodHistoryEntry[];
}

export type SodResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "sod_violation";
      readonly rule: string;
      readonly key: typeof SOD_VIOLATION_KEY;
    };

const ENTRY_KEYS = [
  "chainId",
  "recordId",
  "recordType",
  "action",
  "actorId",
] as const;

/** Validates one entry (or the attempt, with `history` as its one extra key). */
function validEntry(
  value: unknown,
  extra: readonly string[],
): value is SodHistoryEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const allowed: readonly string[] = [...ENTRY_KEYS, ...extra];
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    count += 1;
    if (count > allowed.length || !allowed.includes(key)) return false;
  }
  if (count !== allowed.length) return false;
  const v = value as Record<string, unknown>;
  return (
    isUuidV7(v.chainId) &&
    isUuidV7(v.recordId) &&
    isUserId(v.actorId) &&
    isSubjectType(v.recordType) &&
    typeof v.action === "string" &&
    v.action.length <= LIMITS.permissionName &&
    scopesOf(v.recordType, v.action) !== undefined
  );
}

/**
 * Allows the attempt unless its actor already performed the other side of
 * a pair on the same chain. Throws invalid_sod_input for malformed input
 * and too_many_history (before reading any entry) for a history over
 * LIMITS.sodHistory.
 */
export function checkSod(attempt: SodAttempt): SodResult {
  if (!validEntry(attempt, ["history"]))
    throw new PermissionError("invalid_sod_input");
  const history: unknown = attempt.history;
  if (!Array.isArray(history)) throw new PermissionError("invalid_sod_input");
  if (history.length > LIMITS.sodHistory)
    throw new PermissionError("too_many_history");
  const entries: SodHistoryEntry[] = [];
  for (let i = 0; i < history.length; i += 1) {
    const entry: unknown = history[i];
    if (!validEntry(entry, [])) throw new PermissionError("invalid_sod_input");
    entries.push(entry);
  }
  const attempted = `${attempt.recordType}.${attempt.action}`;
  for (const r of SOD_RULES) {
    const other =
      attempted === r.first
        ? r.second
        : attempted === r.second
          ? r.first
          : undefined;
    if (other === undefined) continue;
    const clash = entries.some(
      (e) =>
        e.chainId === attempt.chainId &&
        e.actorId === attempt.actorId &&
        `${e.recordType}.${e.action}` === other,
    );
    if (clash) {
      return {
        ok: false,
        code: "sod_violation",
        rule: r.id,
        key: SOD_VIOLATION_KEY,
      };
    }
  }
  return { ok: true };
}
