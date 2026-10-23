// P5-06 (ADR 0067, owner condition 4): the audit hash moved here from
// apps/api with the recorder; this is the P4-05 suite over @bricx/db/audit
// (the API keeps its copy through the re-exports).
// P4-05 (ADR 0055): the audit hash. hash = sha256(prev_hash ‖ utf8(JCS(row))),
// where row is every hashed column (condition 3) and JCS is RFC 8785 via the
// canonicalize package. Checked against RFC 8785's own examples and against
// an independent oracle (test/audit-oracle.ts: its own serialiser and
// node:crypto). No database.
import canonicalize from "canonicalize";
import { describe, expect, it, test } from "vitest";
import {
  type HashedRow,
  HASHED_COLUMNS,
  HASH_VERSION,
  KNOWN_HASH_VERSIONS,
  auditHash,
  genesisHash,
  hashedObject,
} from "../src/audit.js";
import { ORACLE_GENESIS, oracleHash, oracleJcs } from "./audit-oracle.js";

const row: HashedRow = {
  id: "0199e1a0-0000-7000-8000-0000000000f1",
  org_id: "0199e1a0-0000-7000-8000-00000000000a",
  seq: "3",
  hash_version: 1,
  occurred_at: "2026-10-16T10:20:26.123Z",
  actor_type: "user",
  actor_id: "0199e1a0-0000-7000-8000-000000000001",
  device_id: "0199e1a0-0000-7000-8000-0000000000de",
  ip: "203.0.113.7",
  geo: { lat_e6: 8_484_146, lon_e6: -13_234_442 },
  correlation_id: "req-42",
  action: "project.task.update",
  entity_type: "project.task",
  entity_id: "0199e1a0-0000-7000-8000-0000000000e1",
  before: { title: "Foundation", amount: { minor: "150000", currency: "SLE" } },
  after: {
    title: "Foundation pour",
    amount: { minor: "175000", currency: "SLE" },
  },
};

describe("canonicalize is RFC 8785", () => {
  // RFC 8785's own JSON texts, with "~" standing for one backslash so the
  // escapes stay escapes in this source file.
  const bs = (t: string): string => t.replaceAll("~", String.fromCharCode(92));

  it("serialises RFC 8785 section 3.2.2's example exactly", () => {
    const input: unknown = JSON.parse(
      bs(
        `{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"~u20ac$~u000F~u000aA'~u0042~u0022~u005c~~~"~/","literals":[null,true,false]}`,
      ),
    );
    expect(canonicalize(input)).toBe(
      bs(
        `{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$~u000f~nA'B~"~~~~~"/"}`,
      ),
    );
  });

  it("sorts keys by UTF-16 code units (RFC 8785 section 3.2.3's example)", () => {
    const input: unknown = JSON.parse(
      bs(
        `{"~u20ac":"Euro Sign","~r":"Carriage Return","~ufb33":"Hebrew Letter Dalet With Dagesh","1":"One","~ud83d~ude00":"Emoji: Grinning Face","~u0080":"Control","~u00f6":"Latin Small Letter O With Diaeresis"}`,
      ),
    );
    const out = canonicalize(input) ?? "";
    const order = [
      "Carriage Return",
      "One",
      "Control",
      "Latin Small Letter O With Diaeresis",
      "Euro Sign",
      "Emoji: Grinning Face",
      "Hebrew Letter Dalet With Dagesh",
    ].map((v) => out.indexOf(v));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("agrees with the oracle's serialiser on an audit row", () => {
    expect(canonicalize(hashedObject(row))).toBe(oracleJcs(hashedObject(row)));
  });
});

describe("the hashed row (ADR 0055, condition 3)", () => {
  it("is exactly these columns, hash and prev_hash excluded", () => {
    expect([...HASHED_COLUMNS]).toEqual([
      "id",
      "org_id",
      "seq",
      "hash_version",
      "occurred_at",
      "actor_type",
      "actor_id",
      "device_id",
      "ip",
      "geo",
      "correlation_id",
      "action",
      "entity_type",
      "entity_id",
      "before",
      "after",
    ]);
    expect(Object.keys(hashedObject(row)).sort()).toEqual(
      [...HASHED_COLUMNS].sort(),
    );
  });

  it("hash_version 1 is the only known version", () => {
    expect(HASH_VERSION).toBe(1);
    expect([...KNOWN_HASH_VERSIONS]).toEqual([1]);
  });

  it("the genesis link is 32 zero bytes", () => {
    expect(genesisHash()).toEqual(Buffer.alloc(32));
    // A fresh copy each call: a caller cannot change the next one.
    genesisHash().fill(1);
    expect(genesisHash()).toEqual(Buffer.alloc(32));
  });
});

describe("auditHash = sha256(prev_hash ‖ utf8(JCS(row)))", () => {
  it("matches the independent oracle, from genesis and from a previous hash", () => {
    expect(auditHash(genesisHash(), row)).toEqual(
      oracleHash(ORACLE_GENESIS, hashedObject(row)),
    );
    const prev = oracleHash(ORACLE_GENESIS, { any: "thing" });
    expect(auditHash(prev, row)).toEqual(oracleHash(prev, hashedObject(row)));
    expect(auditHash(prev, row)).toHaveLength(32);
  });

  it("matches the oracle with every nullable column null", () => {
    const sparse: HashedRow = {
      ...row,
      actor_type: "system",
      actor_id: null,
      device_id: null,
      ip: null,
      geo: null,
      entity_id: null,
      before: null,
      after: null,
    };
    expect(auditHash(genesisHash(), sparse)).toEqual(
      oracleHash(ORACLE_GENESIS, hashedObject(sparse)),
    );
  });

  it("does not depend on key order in before and after", () => {
    const reordered: HashedRow = {
      ...row,
      before: {
        amount: { currency: "SLE", minor: "150000" },
        title: "Foundation",
      },
    };
    expect(auditHash(genesisHash(), reordered)).toEqual(
      auditHash(genesisHash(), row),
    );
  });

  it("changes when prev_hash changes", () => {
    const other = Buffer.alloc(32, 1);
    expect(auditHash(other, row)).not.toEqual(auditHash(genesisHash(), row));
  });

  const changed: Record<(typeof HASHED_COLUMNS)[number], unknown> = {
    id: "0199e1a0-0000-7000-8000-0000000000f2",
    org_id: "0199e1a0-0000-7000-8000-00000000000b",
    seq: "4",
    hash_version: 2,
    occurred_at: "2026-10-16T10:20:26.124Z",
    actor_type: "system",
    actor_id: "0199e1a0-0000-7000-8000-000000000002",
    device_id: "0199e1a0-0000-7000-8000-0000000000df",
    ip: "203.0.113.8",
    geo: { lat_e6: 8_484_146, lon_e6: -13_234_443 },
    correlation_id: "req-43",
    action: "project.task.create",
    entity_type: "project.site",
    entity_id: "0199e1a0-0000-7000-8000-0000000000e2",
    before: { title: "Foundations" },
    after: { title: "Foundation pour", amount: null },
  };

  test.each(HASHED_COLUMNS.map((c) => [c]))(
    "changes when %s changes",
    (column) => {
      const edited: HashedRow = { ...row, [column]: changed[column] };
      expect(auditHash(genesisHash(), edited)).not.toEqual(
        auditHash(genesisHash(), row),
      );
    },
  );
});
