// P5-06 (ADR 0067): the expiry helpers over a fake transaction. The SQL
// side is proven by access-grants.int.test.ts; here the checks before any
// SQL, the row validation and the two outcomes, with a transaction that
// records what it was asked.
import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";
import {
  AccessGrantError,
  MAX_DUE,
  accessGrantsDue,
  expireAccessGrant,
} from "../src/access-grants.js";
import type { Tx } from "../src/database.js";

const ID = "0199e1b0-0000-7000-8000-000000000001";
const ROW = {
  id: ID,
  org_id: "0199e1b0-0000-7000-8000-0000000000a1",
  user_id: "0199e1b0-0000-7000-8000-000000000002",
  permission: "finance.payment.approve.project",
  scope_id: "0199e1b0-0000-7000-8000-0000000000a3",
  granted_by: "0199e1b0-0000-7000-8000-000000000003",
  starts_at: "2026-10-22T09:00:00.000Z",
  expires_at: "2026-10-22T10:00:00.000Z",
  revoked_at: null,
  revoked_by: null,
  expired_at: "2026-10-22T10:00:00.500Z",
  state: "expired",
};

/** A transaction that fails the test if any SQL reaches it. */
const noSql = {
  execute: () => {
    throw new Error("SQL must not run");
  },
} as unknown as Tx;

const dialect = new PgDialect();

/** A transaction answering each execute() with the next rows, recording the SQL. */
function fakeTx(answers: unknown[][]) {
  const seen: string[] = [];
  const tx = {
    execute: (query: SQL | string) => {
      seen.push(
        typeof query === "string" ? query : dialect.sqlToQuery(query).sql,
      );
      const rows = answers.shift();
      if (rows === undefined) throw new Error("unexpected SQL");
      return Promise.resolve({ rows });
    },
  } as unknown as Tx;
  return { tx, seen };
}

async function thrown(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("accessGrantsDue(tx, limit)", () => {
  test.each([0, -1, 1.5, Number.NaN, MAX_DUE + 1, Number.MAX_SAFE_INTEGER])(
    "limit %s: RangeError before any SQL",
    async (limit) => {
      expect(await thrown(() => accessGrantsDue(noSql, limit))).toBeInstanceOf(
        RangeError,
      );
    },
  );

  test("maps the function's rows to {id, orgId, userId}; a row with a non-string column is invalid_result", async () => {
    const { tx, seen } = fakeTx([
      [{ id: ID, org_id: ROW.org_id, user_id: ROW.user_id }],
    ]);
    expect(await accessGrantsDue(tx, 100)).toEqual([
      { id: ID, orgId: ROW.org_id, userId: ROW.user_id },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("app.access_grants_due(");
    const bad = fakeTx([[{ id: ID, org_id: null, user_id: ROW.user_id }]]);
    const error = await thrown(() => accessGrantsDue(bad.tx, 1));
    expect(error).toBeInstanceOf(AccessGrantError);
    expect(error).toMatchObject({
      name: "AccessGrantError",
      code: "invalid_result",
      message: "access grant: invalid_result",
    });
  });
});

describe("expireAccessGrant(tx, grantId)", () => {
  test.each(["", "not-a-uuid", ID.toUpperCase(), `${ID} `, 42, null])(
    "id %s: AccessGrantError invalid_id before any SQL, naming no value",
    async (id) => {
      const error = await thrown(() =>
        expireAccessGrant(noSql, id as unknown as string),
      );
      expect(error).toBeInstanceOf(AccessGrantError);
      expect(error).toMatchObject({
        code: "invalid_id",
        message: "access grant: invalid_id",
      });
    },
  );

  test("the UPDATE returned a row: state expired, changed true, the row without its reason; one statement", async () => {
    const { tx, seen } = fakeTx([[ROW]]);
    const outcome = await expireAccessGrant(tx, ID);
    expect(outcome).toEqual({
      state: "expired",
      changed: true,
      grant: {
        id: ID,
        orgId: ROW.org_id,
        userId: ROW.user_id,
        permission: ROW.permission,
        scopeId: ROW.scope_id,
        grantedBy: ROW.granted_by,
        startsAt: ROW.starts_at,
        expiresAt: ROW.expires_at,
        revokedAt: null,
        revokedBy: null,
        expiredAt: ROW.expired_at,
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(
      /^update bricx\.access_grants set expired_at = now\(\)/i,
    );
    expect(seen[0]).not.toContain("reason");
  });

  test.each(["pending", "open", "revoked", "expired"])(
    "nothing updated, the row found in state %s: changed false; two statements",
    async (state) => {
      const { tx, seen } = fakeTx([[], [{ ...ROW, state }]]);
      expect(await expireAccessGrant(tx, ID)).toMatchObject({
        state,
        changed: false,
        grant: { id: ID },
      });
      expect(seen).toHaveLength(2);
    },
  );

  test("nothing updated and nothing found: undefined", async () => {
    const { tx } = fakeTx([[], []]);
    expect(await expireAccessGrant(tx, ID)).toBeUndefined();
  });

  test.each([
    ["an unknown state", { ...ROW, state: "gone" }],
    ["a missing column", { ...ROW, user_id: undefined }],
    ["a numeric column", { ...ROW, permission: 7 }],
    ["a non-string scope", { ...ROW, scope_id: 7 }],
  ])("%s in the row: invalid_result", async (_what, row) => {
    const error = await thrown(() => expireAccessGrant(fakeTx([[row]]).tx, ID));
    expect(error).toBeInstanceOf(AccessGrantError);
    expect(error).toMatchObject({ code: "invalid_result" });
  });
});
