// P6-06b (ADR 0084): the temporary-membership helpers over a fake
// transaction. The SQL side is proven by migration-0014.int.test.ts and
// apps/worker/test/memberships.int.test.ts; here the checks before any
// SQL, the row validation and the outcomes, with a transaction that
// records what it was asked. Errors carry a code, never a value.
import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";
import type { Tx } from "../src/database.js";
import {
  EXPIRY_NOTICE_DAYS,
  EXPIRY_NOTICE_MS,
  MAX_MEMBERSHIPS_DUE,
  MEMBERSHIP_KINDS,
  MembershipError,
  expireMembership,
  markExpiryNotified,
  membershipsDue,
  membershipsExpiring,
} from "../src/memberships.js";

const ID = "0199e1b4-0000-7000-8000-000000000001";
const ORG = "0199e1b4-0000-7000-8000-0000000000a1";
const USER = "0199e1b4-0000-7000-8000-000000000002";
const ROLE = "0199e1b4-0000-7000-8000-000000000003";
const PROJECT = "0199e1b4-0000-7000-8000-0000000000a3";
const AT = "2026-11-11T12:00:00.000Z";
const ROW = {
  id: ID,
  org_id: ORG,
  user_id: USER,
  role_id: ROLE,
  project_id: null,
  is_external: false,
  expires_at: AT,
  expired_at: "2026-11-11T12:00:00.250Z",
  state: "expired",
};

/** A transaction that fails the test if any SQL reaches it. */
const noSql = {
  execute: () => {
    throw new Error("SQL must not run");
  },
} as unknown as Tx;

const dialect = new PgDialect();

/** A transaction answering each execute() with the next rows, recording the SQL and its parameters. */
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

async function thrown(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("the constants", () => {
  test("two kinds, a 7-day notice, at most 1000 rows per read", () => {
    expect(MEMBERSHIP_KINDS).toEqual(["org", "project"]);
    expect(Object.isFrozen(MEMBERSHIP_KINDS)).toBe(true);
    expect(EXPIRY_NOTICE_DAYS).toBe(7);
    expect(EXPIRY_NOTICE_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(MAX_MEMBERSHIPS_DUE).toBe(1000);
  });
});

describe("checks before any SQL, no value in an error", () => {
  test.each([
    [
      "expire: not a uuid",
      () => expireMembership(noSql, "org", "nope"),
      "invalid_id",
    ],
    [
      "expire: an unknown kind",
      () => expireMembership(noSql, "site" as "org", ID),
      "invalid_kind",
    ],
    [
      "expire: an instant without milliseconds",
      () => expireMembership(noSql, "org", ID, "2026-11-11T12:00:00Z"),
      "invalid_instant",
    ],
    [
      "expire: an instant that is not a string",
      () => expireMembership(noSql, "project", ID, 5 as unknown as string),
      "invalid_instant",
    ],
    [
      "notify: not a uuid",
      () => markExpiryNotified(noSql, "org", "x' OR 1=1"),
      "invalid_id",
    ],
    [
      "notify: an unknown kind",
      () => markExpiryNotified(noSql, "" as "org", ID),
      "invalid_kind",
    ],
  ] as const)("%s", async (_name, work, code) => {
    const error = await thrown(work);
    expect(error).toBeInstanceOf(MembershipError);
    expect((error as MembershipError).code).toBe(code);
    expect((error as MembershipError).name).toBe("MembershipError");
    expect((error as MembershipError).message).toBe(`membership: ${code}`);
  });

  test.each([0, -1, 1001, 1.5, Number.NaN])(
    "a limit of %s is a RangeError, for both reads",
    async (limit) => {
      for (const read of [membershipsDue, membershipsExpiring]) {
        const error = await thrown(() => read(noSql, limit));
        expect(error).toBeInstanceOf(RangeError);
        expect((error as Error).message).toBe(
          "memberships limit: out of range",
        );
      }
    },
  );
});

describe("membershipsDue() and membershipsExpiring()", () => {
  test("call the definer functions with the limit (and the 7 days) and answer kind, id, org and user", async () => {
    const rows = [
      { kind: "org", id: ID, org_id: ORG, user_id: USER },
      { kind: "project", id: ID, org_id: ORG, user_id: USER },
    ];
    const due = fakeTx([rows]);
    expect(await membershipsDue(due.tx, 25)).toEqual([
      { kind: "org", id: ID, orgId: ORG, userId: USER },
      { kind: "project", id: ID, orgId: ORG, userId: USER },
    ]);
    expect(due.seen[0]?.sql).toContain("FROM app.memberships_due(");
    expect(due.seen[0]?.params).toEqual([25]);
    const expiring = fakeTx([rows]);
    expect(await membershipsExpiring(expiring.tx, 1000)).toHaveLength(2);
    expect(expiring.seen[0]?.sql).toContain("FROM app.memberships_expiring(");
    expect(expiring.seen[0]?.params).toEqual([7, 1000]);
  });

  test.each([
    [{ kind: "site", id: ID, org_id: ORG, user_id: USER }, "invalid_kind"],
    [{ kind: "org", id: 5, org_id: ORG, user_id: USER }, "invalid_result"],
    [{ kind: "org", id: ID, org_id: null, user_id: USER }, "invalid_result"],
    [{ kind: "org", id: ID, org_id: ORG }, "invalid_result"],
  ])("a row of another shape is refused (%#)", async (row, code) => {
    const error = await thrown(() => membershipsDue(fakeTx([[row]]).tx, 1));
    expect(error).toBeInstanceOf(MembershipError);
    expect((error as MembershipError).code).toBe(code);
  });
});

describe("expireMembership()", () => {
  test("org: the UPDATE answers the expired row: changed, with the audited columns and never the suspension reason", async () => {
    const { tx, seen } = fakeTx([[ROW]]);
    const outcome = await expireMembership(tx, "org", ID);
    expect(outcome).toEqual({
      membership: {
        kind: "org",
        id: ID,
        orgId: ORG,
        userId: USER,
        roleId: ROLE,
        projectId: null,
        external: false,
        expiresAt: AT,
        expiredAt: "2026-11-11T12:00:00.250Z",
      },
      state: "expired",
      changed: true,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.sql).toContain(
      "UPDATE bricx.memberships SET expired_at = now()",
    );
    // The database clock decides, on an open, unrecorded, temporary row.
    expect(seen[0]?.sql).toContain("removed_at IS NULL AND expired_at IS NULL");
    expect(seen[0]?.sql).toContain("expires_at <= now()");
    expect(seen[0]?.sql).not.toContain("suspend_reason");
    expect(seen[0]?.params).toEqual([ID]);
  });

  test("project: its own two statements; the external flag is the org membership's", async () => {
    const row = { ...ROW, project_id: PROJECT, is_external: true };
    const { tx, seen } = fakeTx([[row]]);
    const outcome = await expireMembership(tx, "project", ID);
    expect(outcome?.membership).toMatchObject({
      kind: "project",
      projectId: PROJECT,
      external: true,
    });
    expect(seen[0]?.sql).toContain("UPDATE bricx.project_memberships pm");
    expect(seen[0]?.sql).toContain("FROM bricx.memberships m");
  });

  test.each(["open", "renewed", "permanent", "removed", "expired"] as const)(
    "nothing to change: the row's state (%s) and changed false, after one UPDATE and one SELECT",
    async (state) => {
      for (const kind of MEMBERSHIP_KINDS) {
        const { tx, seen } = fakeTx([[], [{ ...ROW, state }]]);
        const outcome = await expireMembership(tx, kind, ID, AT);
        expect(outcome?.state).toBe(state);
        expect(outcome?.changed).toBe(false);
        expect(seen).toHaveLength(2);
        // The instant a delayed job was made for decides `renewed`.
        expect(seen[1]?.sql).toContain("'renewed'");
        expect(seen[1]?.params).toContain(AT);
      }
    },
  );

  test("without scheduledFor the SELECT binds NULL, so a row is never `renewed` for the sweep", async () => {
    const { tx, seen } = fakeTx([[], [{ ...ROW, state: "open" }]]);
    await expireMembership(tx, "org", ID);
    expect(seen[1]?.params).toEqual([null, null, ID]);
  });

  test("a row the transaction cannot see is undefined", async () => {
    for (const kind of MEMBERSHIP_KINDS) {
      expect(
        await expireMembership(fakeTx([[], []]).tx, kind, ID),
      ).toBeUndefined();
    }
  });

  test.each([
    [{ ...ROW, state: "gone" }],
    [{ ...ROW, is_external: "f" }],
    [{ ...ROW, role_id: null }],
    [{ ...ROW, expires_at: 5 }],
    [{ ...ROW, project_id: 7 }],
  ])("a row of another shape is invalid_result (%#)", async (row) => {
    const error = await thrown(() =>
      expireMembership(fakeTx([[row]]).tx, "org", ID),
    );
    expect(error).toBeInstanceOf(MembershipError);
    expect((error as MembershipError).code).toBe("invalid_result");
  });
});

describe("markExpiryNotified()", () => {
  test("claims the one notice of an open, unexpired, temporary row that has none: true once, false after", async () => {
    for (const [kind, table] of [
      ["org", "bricx.memberships"],
      ["project", "bricx.project_memberships"],
    ] as const) {
      const first = fakeTx([[{ id: ID }]]);
      expect(await markExpiryNotified(first.tx, kind, ID)).toBe(true);
      expect(first.seen[0]?.sql).toContain(
        `UPDATE ${table} SET expiry_notified_at = now()`,
      );
      expect(first.seen[0]?.sql).toContain("expiry_notified_at IS NULL");
      expect(first.seen[0]?.sql).toContain("expired_at IS NULL");
      expect(first.seen[0]?.sql).toContain("removed_at IS NULL");
      expect(first.seen[0]?.params).toEqual([ID]);
      expect(await markExpiryNotified(fakeTx([[]]).tx, kind, ID)).toBe(false);
    }
  });
});
