// P4-05 (ADR 0055): the chain check without a database (ChainWalker), on
// synthetic rows hashed by the independent oracle. test/audit.int.test.ts
// runs the same check through verifyAuditChain() and the CLI on rows
// Postgres stored.
import { describe, expect, it, test } from "vitest";
import {
  AuditContextError,
  AuditIsolationError,
} from "../src/modules/audit/audit-errors.js";
import {
  ChainWalker,
  type StoredAuditRow,
} from "../src/modules/audit/audit-chain.js";
import { ORACLE_GENESIS, oracleHash } from "./audit-oracle.js";

const ORG = "0199e1a0-0000-7000-8000-00000000000a";

/** Five rows of one org, each hashed by the oracle and linked. */
function chain(): StoredAuditRow[] {
  const rows: StoredAuditRow[] = [];
  let prev: Buffer = Buffer.from(ORACLE_GENESIS);
  for (let n = 1; n <= 5; n += 1) {
    const hashed = {
      id: `0199e1a0-0000-7000-8000-00000000f00${String(n)}`,
      org_id: ORG,
      seq: String(n),
      hash_version: 1,
      occurred_at: `2026-10-16T10:20:2${String(n)}.000Z`,
      actor_type: "user",
      actor_id: "0199e1a0-0000-7000-8000-000000000001",
      device_id: null,
      ip: "203.0.113.7",
      geo: { lat_e6: 8_484_146, lon_e6: -13_234_442 },
      correlation_id: `req-${String(n)}`,
      action: "project.task.update",
      entity_type: "project.task",
      entity_id: null,
      before: { n: n - 1 },
      after: { n },
    };
    const hash = oracleHash(prev, hashed);
    rows.push({ ...hashed, prev_hash: prev, hash });
    prev = hash;
  }
  return rows;
}

function walk(rows: readonly StoredAuditRow[]) {
  const walker = new ChainWalker();
  for (const row of rows) {
    if (walker.next(row) !== undefined) break;
  }
  return walker.result();
}

describe("ChainWalker", () => {
  it("an empty chain is intact with no head", () => {
    expect(walk([])).toEqual({ status: "intact", events: 0, head: null });
    expect(new ChainWalker().lastSeq).toBe("0");
  });

  it("an untouched chain is intact; the head is the last seq and hash", () => {
    const rows = chain();
    const walker = new ChainWalker();
    for (const row of rows) expect(walker.next(row)).toBeUndefined();
    expect(walker.lastSeq).toBe("5");
    expect(walker.result()).toEqual({
      status: "intact",
      events: 5,
      head: { seq: "5", hash: rows[4]?.hash.toString("hex") },
    });
  });

  const third = (edit: (row: StoredAuditRow) => StoredAuditRow) =>
    chain().map((row) => (row.seq === "3" ? edit(row) : row));

  test.each<
    [string, (rows: StoredAuditRow[]) => StoredAuditRow[], string, string]
  >([
    ["a deleted row", (r) => r.filter((x) => x.seq !== "3"), "3", "seq_gap"],
    [
      "an edited column",
      () => third((x) => ({ ...x, action: "project.task.delete" })),
      "3",
      "hash_mismatch",
    ],
    [
      "an edited prev_hash",
      () => third((x) => ({ ...x, prev_hash: Buffer.alloc(32, 7) })),
      "3",
      "prev_hash_mismatch",
    ],
    [
      "an edited hash",
      () => third((x) => ({ ...x, hash: Buffer.alloc(32, 7) })),
      "3",
      "hash_mismatch",
    ],
    [
      "an unknown hash_version",
      () => third((x) => ({ ...x, hash_version: 2 })),
      "3",
      "unknown_hash_version",
    ],
    ["a first row not linked to genesis", (r) => r.slice(1), "1", "seq_gap"],
    [
      "two swapped rows",
      (r) => {
        const [a, b, c, ...rest] = r;
        if (a === undefined || b === undefined || c === undefined)
          throw new Error("short");
        return [a, { ...c, seq: "2" }, { ...b, seq: "3" }, ...rest];
      },
      "2",
      "prev_hash_mismatch",
    ],
  ])("%s breaks at seq %s", (_name, edit, seq, reason) => {
    const result = walk(edit(chain()));
    expect(result).toMatchObject({ status: "broken", seq, reason });
  });

  it("stays broken: rows after a break change nothing", () => {
    const rows = chain();
    const walker = new ChainWalker();
    const [first, , third, fourth] = rows;
    if (first === undefined || third === undefined || fourth === undefined) {
      throw new Error("short");
    }
    walker.next(first);
    const broken = walker.next(third);
    expect(broken).toMatchObject({ seq: "2", reason: "seq_gap", id: third.id });
    expect(walker.next(fourth)).toEqual(broken);
    expect(walker.result()).toEqual(broken);
  });
});

describe("audit errors carry codes, never values", () => {
  it("AuditContextError and AuditIsolationError", () => {
    expect(new AuditContextError()).toMatchObject({
      name: "AuditContextError",
      code: "audit.no_tenant_context",
      message: "audit refused: no tenant context",
    });
    expect(new AuditIsolationError()).toMatchObject({
      name: "AuditIsolationError",
      code: "audit.isolation_not_read_committed",
    });
  });
});
