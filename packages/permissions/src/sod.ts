// Segregation of duties (ROADMAP P3-05 step 4; CLAUDE.md rule 10; architect
// rulings 5 and 6; ADR 0048). A pair is two actions one actor may not both
// perform on the same record chain. The chain is identified by chainId, the
// originating record: the PO for its goods receipts, the payment for its
// reconciliation, the record itself for request/approve. checkSod is a pure
// function of the attempt and the chain's history; the API (P5-07) loads
// the history and calls it on the server. There is no override for anyone,
// owners included (the one-member organisation case is a pending decision,
// docs/adr/pending.md).
import { checkSodWith } from "./sod-check.ts";
import type { SodAttempt, SodResult } from "./sod-check.ts";
import { SOD_RULES } from "./sod-rules.ts";

export { SOD_RULES } from "./sod-rules.ts";
export type { SodRule } from "./sod-rules.ts";
export type { SodAttempt, SodHistoryEntry, SodResult } from "./sod-check.ts";

/**
 * Allows the attempt unless its actor already performed the other side of
 * a pair on the same chain. Throws invalid_sod_input for malformed input
 * and too_many_history (before reading any entry) for a history over
 * LIMITS.sodHistory.
 */
export function checkSod(attempt: SodAttempt): SodResult {
  return checkSodWith(SOD_RULES, attempt);
}
