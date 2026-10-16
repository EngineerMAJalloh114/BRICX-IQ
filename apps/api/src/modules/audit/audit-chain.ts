// Verifies the current org's audit chain (P4-05, ADR 0055), in seq order,
// in batches so memory stays bounded. For each row, in this order:
//   seq_gap               its seq is not the next one (a row deleted, or
//                         its seq or org_id changed);
//   unknown_hash_version  its hash_version is not one this code knows;
//   prev_hash_mismatch    prev_hash is not the previous row's hash;
//   hash_mismatch         hash is not sha256(prev_hash ‖ JCS(row)).
// The first failure is reported. Deleting the newest rows leaves a valid,
// shorter chain: only an external record of the head shows that (ADR 0055,
// P13).
import { type Tx } from "@bricx/db/database";
import { sql } from "drizzle-orm";
import { AuditContextError } from "./audit-errors.js";
import {
  type HashedRow,
  KNOWN_HASH_VERSIONS,
  auditHash,
  genesisHash,
} from "./audit-hash.js";

export type ChainBreak =
  "seq_gap" | "unknown_hash_version" | "prev_hash_mismatch" | "hash_mismatch";

export type ChainResult =
  | {
      readonly status: "intact";
      readonly events: number;
      /** The last row's seq and hash (hex); null for an empty chain. */
      readonly head: { readonly seq: string; readonly hash: string } | null;
    }
  | {
      readonly status: "broken";
      /** The seq where the chain breaks (for a gap, the missing one). */
      readonly seq: string;
      /** The row found there. */
      readonly id: string;
      readonly reason: ChainBreak;
    };

export interface VerifyOptions {
  /** Rows per query (default 1000). */
  readonly batchSize?: number;
}

/** One row as verifyAuditChain() reads it back (ADR 0055's forms). */
export type StoredAuditRow = HashedRow & {
  readonly id: string;
  readonly seq: string;
  readonly hash_version: number;
  readonly prev_hash: Buffer;
  readonly hash: Buffer;
};

const DEFAULT_BATCH = 1000;

/**
 * The chain check without the database: feed rows in seq order to next();
 * it returns the first break, then result() is the verdict.
 */
export class ChainWalker {
  private expected = 1n;
  private prev: Buffer = genesisHash();
  private events = 0;
  private head: string | null = null;
  private broken: ChainResult | undefined;

  /** The break `row` causes, or undefined when it extends the chain. */
  next(row: StoredAuditRow): ChainResult | undefined {
    if (this.broken !== undefined) return this.broken;
    const at = String(this.expected);
    const reason: ChainBreak | undefined =
      row.seq !== at
        ? "seq_gap"
        : !KNOWN_HASH_VERSIONS.includes(row.hash_version)
          ? "unknown_hash_version"
          : !row.prev_hash.equals(this.prev)
            ? "prev_hash_mismatch"
            : !auditHash(this.prev, row).equals(row.hash)
              ? "hash_mismatch"
              : undefined;
    if (reason !== undefined) {
      this.broken = { status: "broken", seq: at, id: row.id, reason };
      return this.broken;
    }
    this.prev = row.hash;
    this.expected += 1n;
    this.events += 1;
    this.head = row.seq;
    return undefined;
  }

  /** The seq of the last row that extended the chain ("0" before any). */
  get lastSeq(): string {
    return this.head ?? "0";
  }

  result(): ChainResult {
    if (this.broken !== undefined) return this.broken;
    return {
      status: "intact",
      events: this.events,
      head:
        this.head === null
          ? null
          : { seq: this.head, hash: this.prev.toString("hex") },
    };
  }
}

/** Walks the chain of the transaction's org (app.current_org()). */
export async function verifyAuditChain(
  tx: Tx,
  options: VerifyOptions = {},
): Promise<ChainResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new RangeError(
      "verifyAuditChain: batchSize must be a positive integer",
    );
  }
  const who = await tx.execute<{ org: string | null }>(
    sql`SELECT app.current_org()::text AS org`,
  );
  if ((who.rows[0]?.org ?? null) === null) throw new AuditContextError();

  const walker = new ChainWalker();
  for (;;) {
    // Every column read back in the form the writer hashed (ADR 0055).
    const batch = await tx.execute<StoredAuditRow>(
      sql`SELECT id::text AS id, org_id::text AS org_id, seq::text AS seq,
                 hash_version,
                 to_char(occurred_at AT TIME ZONE 'UTC',
                         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at,
                 actor_type, actor_id::text AS actor_id,
                 device_id::text AS device_id, ip::text AS ip, geo,
                 correlation_id, action, entity_type,
                 entity_id::text AS entity_id, before, after, prev_hash, hash
          FROM bricx.audit_events
          WHERE org_id = app.current_org() AND seq > ${walker.lastSeq}::bigint
          ORDER BY audit_events.seq LIMIT ${batchSize}`,
    );
    for (const row of batch.rows) {
      const broken = walker.next(row);
      if (broken !== undefined) return broken;
    }
    if (batch.rows.length < batchSize) return walker.result();
  }
}
