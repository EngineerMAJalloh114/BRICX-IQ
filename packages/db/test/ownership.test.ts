// P6-06c (ADR 0085): the ownership-transfer statements over a fake
// transaction. The SQL side is proven by migration-0015.int.test.ts,
// apps/api/test/modules/ownership-transfers.int.test.ts and
// apps/worker/test/ownership.int.test.ts; here the checks before any SQL,
// the row validation and the outcomes. Errors carry a code, never a value.
import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";
import type { Tx } from "../src/database.js";
import {
  MAX_DUE_TRANSFERS,
  OwnershipError,
  cancelPendingTransfers,
  expireOwnershipTransfer,
  ownershipTransfersDue,
  transferRecordOf,
} from "../src/ownership.js";

const ID = "0199e1b4-0000-7000-8000-000000000101";
const ORG = "0199e1b4-0000-7000-8000-0000000001a1";
const OWNER = "0199e1b4-0000-7000-8000-000000000102";
const RECIPIENT = "0199e1b4-0000-7000-8000-000000000103";
const ROLE = "0199e1b4-0000-7000-8000-000000000104";
const AT = "2026-11-12T12:00:00.000Z";
const ROW = {
  id: ID,
  org_id: ORG,
  initiated_by: OWNER,
  to_user_id: RECIPIENT,
  previous_owner_role_id: ROLE,
  status: "expired",
  expires_at: AT,
};

const noSql = {
  execute: () => {
    throw new Error("SQL must not run");
  },
} as unknown as Tx;

const dialect = new PgDialect();

function fakeTx(answers: unknown[][]) {
  const seen: { sql: string; params: unknown[] }[] = [];
  const tx = {
    execute: (query: SQL) => {
      const built = dialect.sqlToQuery(query);
      seen.push({ sql: built.sql, params: built.params });
      const rows = answers.shift();
      if (rows === undefined) throw new Error("unexpected SQL");
      return Promise.resolve({ rows });
    },
  } as unknown as Tx;
  return { tx, seen };
}

async function codeOf(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error instanceof OwnershipError ? error.code : error;
  }
  return undefined;
}

describe("expireOwnershipTransfer()", () => {
  test("refuses a bad id or instant before any SQL, naming no value", async () => {
    expect(await codeOf(() => expireOwnershipTransfer(noSql, "x", AT))).toBe(
      "invalid_id",
    );
    expect(
      await codeOf(() => expireOwnershipTransfer(noSql, ID, "2026-11-12")),
    ).toBe("invalid_instant");
    const error = new OwnershipError("invalid_id");
    expect(error.message).toBe("ownership: invalid_id");
    expect(error.name).toBe("OwnershipError");
  });

  test("changed: the expired record; one conditional UPDATE at the given instant", async () => {
    const { tx, seen } = fakeTx([[ROW]]);
    expect(await expireOwnershipTransfer(tx, ID, AT)).toEqual({
      changed: true,
      transfer: transferRecordOf(ROW),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.sql).toContain("status = 'pending'");
    expect(seen[0]?.params).toEqual([AT, AT, ID, AT]);
  });

  test("unchanged: early while pending, settled otherwise, undefined when unseen", async () => {
    expect(
      await expireOwnershipTransfer(
        fakeTx([[], [{ status: "pending" }]]).tx,
        ID,
        AT,
      ),
    ).toEqual({ changed: false, state: "early" });
    expect(
      await expireOwnershipTransfer(
        fakeTx([[], [{ status: "accepted" }]]).tx,
        ID,
        AT,
      ),
    ).toEqual({ changed: false, state: "settled" });
    expect(
      await expireOwnershipTransfer(fakeTx([[], []]).tx, ID, AT),
    ).toBeUndefined();
  });

  test("a row that is not the expected shape is invalid_result", async () => {
    expect(
      await codeOf(() =>
        expireOwnershipTransfer(fakeTx([[{ ...ROW, id: 7 }]]).tx, ID, AT),
      ),
    ).toBe("invalid_result");
  });
});

describe("ownershipTransfersDue()", () => {
  test("the limit is clamped to 0..MAX_DUE_TRANSFERS; rows are mapped", async () => {
    expect(MAX_DUE_TRANSFERS).toBe(100);
    for (const [limit, sent] of [
      [5, 5],
      [-1, 0],
      [1_000, 100],
      [1.5, 0],
    ] as const) {
      const { tx, seen } = fakeTx([
        [{ id: ID, org_id: ORG, to_user_id: RECIPIENT }],
      ]);
      expect(await ownershipTransfersDue(tx, limit)).toEqual([
        { id: ID, orgId: ORG, toUserId: RECIPIENT },
      ]);
      expect(seen[0]?.params).toEqual([sent]);
    }
  });
});

describe("cancelPendingTransfers()", () => {
  test("refuses bad ids or instants before any SQL", async () => {
    const input = { orgId: ORG, by: OWNER, now: AT };
    expect(
      await codeOf(() =>
        cancelPendingTransfers(noSql, { ...input, orgId: "x" }),
      ),
    ).toBe("invalid_id");
    expect(
      await codeOf(() => cancelPendingTransfers(noSql, { ...input, by: "x" })),
    ).toBe("invalid_id");
    expect(
      await codeOf(() =>
        cancelPendingTransfers(noSql, { ...input, userId: "x" }),
      ),
    ).toBe("invalid_id");
    expect(
      await codeOf(() => cancelPendingTransfers(noSql, { ...input, now: "x" })),
    ).toBe("invalid_instant");
  });

  test("answers each cancelled transfer with its cause; an unknown cause is invalid_result", async () => {
    const cancelled = { ...ROW, status: "cancelled" };
    for (const cause of [
      "initiator_changed",
      "recipient_changed",
      "org_archived",
    ]) {
      const { tx } = fakeTx([[{ ...cancelled, cancel_reason: cause }]]);
      expect(
        await cancelPendingTransfers(tx, {
          orgId: ORG,
          userId: RECIPIENT,
          by: OWNER,
          now: AT,
        }),
      ).toEqual([{ ...transferRecordOf(cancelled), cause }]);
    }
    expect(
      await codeOf(() =>
        cancelPendingTransfers(
          fakeTx([[{ ...cancelled, cancel_reason: "manual" }]]).tx,
          { orgId: ORG, by: OWNER, now: AT },
        ),
      ),
    ).toBe("invalid_result");
  });
});
