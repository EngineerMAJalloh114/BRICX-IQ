// P6-06c (ADR 0085): the bulk-batch statements over a fake transaction.
// The SQL side is proven by migration-0015.int.test.ts and the API and
// worker batch suites; here the checks before any SQL, the row validation
// and the outcomes. Errors carry a code, never a value; no address is
// ever in an error.
import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";
import type { Tx } from "../src/database.js";
import {
  BATCH_PURGE_AFTER_MS,
  BATCH_ROW_ERROR_CODES,
  BatchError,
  batchInviterState,
  failPendingRows,
  finishBatch,
  pendingBatchRows,
  readBatch,
  settleBatchRow,
  staleBatches,
  startBatch,
} from "../src/invitation-batches.js";

const BATCH = "0199e1b4-0000-7000-8000-000000000201";
const ORG = "0199e1b4-0000-7000-8000-0000000002a1";
const USER = "0199e1b4-0000-7000-8000-000000000202";
const ROLE = "0199e1b4-0000-7000-8000-000000000203";
const INV = "0199e1b4-0000-7000-8000-000000000204";
const AT = "2026-11-12T12:00:00.000Z";
const ADDRESS = "secret-address@site.example";

const noSql = {
  execute: () => {
    throw new Error("SQL must not run");
  },
} as unknown as Tx;

const dialect = new PgDialect();

function fakeTx(answers: { rows: unknown[]; rowCount?: number }[]) {
  const seen: { sql: string; params: unknown[] }[] = [];
  const tx = {
    execute: (query: SQL) => {
      const built = dialect.sqlToQuery(query);
      seen.push({ sql: built.sql, params: built.params });
      const answer = answers.shift();
      if (answer === undefined) throw new Error("unexpected SQL");
      return Promise.resolve(answer);
    },
  } as unknown as Tx;
  return { tx, seen };
}

async function codeOf(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    if (error instanceof BatchError) {
      expect(error.message).not.toContain("@");
      return error.code;
    }
    return error;
  }
  return undefined;
}

describe("the constants", () => {
  test("ten row codes (the table's CHECK list), frozen; the purge after one hour", () => {
    expect(BATCH_ROW_ERROR_CODES).toEqual([
      "validation_failed",
      "not_found",
      "conflict",
      "escalation",
      "owner_role",
      "project_archived",
      "pending_exists",
      "inviter_inactive",
      "org_archived",
      "not_processed",
    ]);
    expect(Object.isFrozen(BATCH_ROW_ERROR_CODES)).toBe(true);
    expect(BATCH_PURGE_AFTER_MS).toBe(3_600_000);
    expect(new BatchError("invalid_id").name).toBe("BatchError");
  });
});

describe("the checks before any SQL", () => {
  test("bad ids, instants and codes are refused by code", async () => {
    expect(await codeOf(() => readBatch(noSql, "x"))).toBe("invalid_id");
    expect(await codeOf(() => startBatch(noSql, BATCH, "x"))).toBe(
      "invalid_instant",
    );
    expect(await codeOf(() => pendingBatchRows(noSql, "x", 1))).toBe(
      "invalid_id",
    );
    expect(
      await codeOf(() =>
        settleBatchRow(noSql, {
          batchId: BATCH,
          rowNo: 1.5,
          now: AT,
          invitationId: INV,
        }),
      ),
    ).toBe("invalid_id");
    expect(
      await codeOf(() =>
        settleBatchRow(noSql, {
          batchId: BATCH,
          rowNo: 1,
          now: AT,
          invitationId: "x",
        }),
      ),
    ).toBe("invalid_id");
    expect(
      await codeOf(() =>
        failPendingRows(
          noSql,
          BATCH,
          // A code outside the CHECK list.
          "made_up" as (typeof BATCH_ROW_ERROR_CODES)[number],
          AT,
        ),
      ),
    ).toBe("invalid_code");
    expect(await codeOf(() => finishBatch(noSql, BATCH, "x"))).toBe(
      "invalid_instant",
    );
    expect(await codeOf(() => batchInviterState(noSql, ORG, "x", AT))).toBe(
      "invalid_id",
    );
  });
});

describe("the statements' outcomes", () => {
  test("readBatch: the state, undefined when unseen, invalid_result on a bad status", async () => {
    const row = {
      id: BATCH,
      org_id: ORG,
      created_by: USER,
      status: "queued",
      created_at: AT,
    };
    expect(await readBatch(fakeTx([{ rows: [row] }]).tx, BATCH)).toEqual({
      id: BATCH,
      orgId: ORG,
      createdBy: USER,
      status: "queued",
      createdAt: AT,
    });
    expect(await readBatch(fakeTx([{ rows: [] }]).tx, BATCH)).toBeUndefined();
    expect(
      await codeOf(() =>
        readBatch(fakeTx([{ rows: [{ ...row, status: "lost" }] }]).tx, BATCH),
      ),
    ).toBe("invalid_result");
  });

  test("startBatch and settleBatchRow answer whether one row changed; a settlement clears the address", async () => {
    expect(
      await startBatch(fakeTx([{ rows: [], rowCount: 1 }]).tx, BATCH, AT),
    ).toBe(true);
    expect(
      await startBatch(fakeTx([{ rows: [], rowCount: 0 }]).tx, BATCH, AT),
    ).toBe(false);
    const created = fakeTx([{ rows: [], rowCount: 1 }]);
    expect(
      await settleBatchRow(created.tx, {
        batchId: BATCH,
        rowNo: 2,
        now: AT,
        invitationId: INV,
      }),
    ).toBe(true);
    expect(created.seen[0]?.sql).toContain("email_normalised = NULL");
    expect(created.seen[0]?.params).toContain("created");
    const failed = fakeTx([{ rows: [] }]);
    expect(
      await settleBatchRow(failed.tx, {
        batchId: BATCH,
        rowNo: 2,
        now: AT,
        errorCode: "pending_exists",
      }),
    ).toBe(false);
    expect(failed.seen[0]?.params).toContain("failed");
    expect(failed.seen[0]?.params).toContain("pending_exists");
    expect(
      await failPendingRows(
        fakeTx([{ rows: [], rowCount: 3 }]).tx,
        BATCH,
        "not_processed",
        AT,
      ),
    ).toBe(3);
    expect(
      await failPendingRows(
        fakeTx([{ rows: [] }]).tx,
        BATCH,
        "not_processed",
        AT,
      ),
    ).toBe(0);
  });

  test("pendingBatchRows: the limit clamped to 0..200; the rows mapped", async () => {
    for (const [limit, sent] of [
      [5, 5],
      [-3, 0],
      [500, 200],
      [Number.NaN, 0],
    ] as const) {
      const { tx, seen } = fakeTx([
        {
          rows: [
            {
              row_no: 1,
              email_normalised: ADDRESS,
              role_id: ROLE,
              project_id: null,
              project_role_id: null,
              is_external: false,
              membership_expires_at: null,
            },
          ],
        },
      ]);
      expect(await pendingBatchRows(tx, BATCH, limit)).toEqual([
        {
          rowNo: 1,
          email: ADDRESS,
          roleId: ROLE,
          projectId: null,
          projectRoleId: null,
          external: false,
          membershipExpiresAt: null,
        },
      ]);
      expect(seen[0]?.params.at(-1)).toBe(sent);
    }
    expect(
      await codeOf(() =>
        pendingBatchRows(fakeTx([{ rows: [{ row_no: "x" }] }]).tx, BATCH, 1),
      ),
    ).toBe("invalid_result");
  });

  test("finishBatch: the counts when it closed the batch, else undefined", async () => {
    expect(
      await finishBatch(
        fakeTx([{ rows: [{ created_count: "2", failed_count: 1 }] }]).tx,
        BATCH,
        AT,
      ),
    ).toEqual({ created: 2, failed: 1 });
    expect(
      await finishBatch(fakeTx([{ rows: [] }]).tx, BATCH, AT),
    ).toBeUndefined();
  });

  test("staleBatches: the limit clamped to 0..100; the rows mapped", async () => {
    for (const [limit, sent] of [
      [7, 7],
      [0, 0],
      [101, 100],
    ] as const) {
      const { tx, seen } = fakeTx([
        { rows: [{ id: BATCH, org_id: ORG, created_by: USER }] },
      ]);
      expect(await staleBatches(tx, limit)).toEqual([
        { id: BATCH, orgId: ORG, createdBy: USER },
      ]);
      expect(seen[0]?.params).toEqual([sent]);
    }
  });

  test("batchInviterState: archived org first, then an active membership", async () => {
    const state = (rows: unknown[]) =>
      batchInviterState(fakeTx([{ rows }]).tx, ORG, USER, AT);
    expect(await state([{ archived: true, active: true }])).toBe(
      "org_archived",
    );
    expect(await state([{ archived: null, active: false }])).toBe(
      "org_archived",
    );
    expect(await state([{ archived: false, active: false }])).toBe("inactive");
    expect(await state([{ archived: false, active: true }])).toBe("active");
  });
});
