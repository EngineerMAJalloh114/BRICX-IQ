// P6-06 (ADR 0077): the invitation helpers over a fake transaction. The
// SQL side (the definer functions, the conditional mint, the cascades, the
// immutability trigger) is proven by invitations.int.test.ts; here the
// token (D1: 32 CSPRNG bytes, base64url, SHA-256 stored, constant-time
// compare, `<cell>.<secret>`), the checks before any SQL, the row
// validation, and that no error carries a value.
import { createHash } from "node:crypto";
import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";
import type { Tx } from "../src/database.js";
import {
  INVITATION_SECRET_BYTES,
  INVITATION_STATUSES,
  INVITATION_TOKEN_MAX,
  InvitationError,
  MAX_DUE_INVITATIONS,
  REVOKE_REASONS,
  expireInvitation,
  hashInvitationSecret,
  invitationByTokenHash,
  invitationMessageSettings,
  invitationTokenOf,
  invitationsDue,
  mintInvitationToken,
  newInvitationSecret,
  parseInvitationToken,
  pendingInvitationAddress,
  revokePendingInvitations,
  sameInvitationHash,
} from "../src/invitations.js";

const ID = "0199e1b0-0000-7000-8000-0000000000b1";
const ORG = "0199e1b0-0000-7000-8000-0000000000a1";
const USER = "0199e1b0-0000-7000-8000-000000000002";
const NOW = "2026-11-10T12:00:00.000Z";
const HASH = Buffer.alloc(32, 7);
const NEEDLE = "needle-3b77@example.test";

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
      const q = dialect.sqlToQuery(query);
      seen.push({ sql: q.sql, params: q.params });
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
  throw new Error("expected a throw");
}

describe("the token (D1)", () => {
  test("a secret is 32 random bytes as 43 base64url characters; two differ", () => {
    const a = newInvitationSecret();
    const b = newInvitationSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a, "base64url")).toHaveLength(INVITATION_SECRET_BYTES);
    expect(a).not.toBe(b);
  });

  test("the stored hash is SHA-256 of the secret's 32 bytes; compare is by value", () => {
    const secret = newInvitationSecret();
    const hash = hashInvitationSecret(secret);
    expect(hash).toEqual(
      createHash("sha256").update(Buffer.from(secret, "base64url")).digest(),
    );
    expect(sameInvitationHash(hash, Buffer.from(hash))).toBe(true);
    expect(sameInvitationHash(hash, HASH)).toBe(false);
    expect(sameInvitationHash(hash, hash.subarray(0, 31))).toBe(false);
    expect(() => hashInvitationSecret("short")).toThrow(InvitationError);
  });

  test("<cell>.<secret> round-trips; anything else is undefined, bounded first", () => {
    const secret = newInvitationSecret();
    const token = invitationTokenOf("af-south-1", secret);
    expect(token.length).toBeLessThanOrEqual(INVITATION_TOKEN_MAX);
    expect(parseInvitationToken(token)).toEqual({
      cellId: "af-south-1",
      secret,
    });
    for (const bad of [
      undefined,
      42,
      "",
      secret,
      `.${secret}`,
      `AF-south-1.${secret}`,
      `af-south-1.${secret}x`,
      `af-south-1.${secret.slice(1)}`,
      `af-south-1.${secret}`.padStart(INVITATION_TOKEN_MAX + 1, "a"),
    ]) {
      expect(parseInvitationToken(bad)).toBeUndefined();
    }
    expect(() => invitationTokenOf("nope", secret)).toThrow(InvitationError);
  });

  test("the statuses and revoke reasons are the table's", () => {
    expect(INVITATION_STATUSES).toEqual([
      "pending",
      "accepted",
      "expired",
      "revoked",
    ]);
    expect(REVOKE_REASONS).toEqual([
      "manual",
      "inviter_removed",
      "inviter_lacks_rights",
      "project_archived",
      "org_archived",
    ]);
  });
});

describe("checks before any SQL, no value in an error", () => {
  test.each([
    [
      "by hash: a short hash",
      () => invitationByTokenHash(noSql, Buffer.alloc(31)),
    ],
    ["due: limit 0", () => invitationsDue(noSql, 0)],
    [
      "due: limit past the cap",
      () => invitationsDue(noSql, MAX_DUE_INVITATIONS + 1),
    ],
    [
      "mint: a bad id",
      () =>
        mintInvitationToken(noSql, {
          id: NEEDLE,
          sendSeq: 1,
          hash: HASH,
          now: NOW,
        }),
    ],
    [
      "mint: sendSeq 0",
      () =>
        mintInvitationToken(noSql, {
          id: ID,
          sendSeq: 0,
          hash: HASH,
          now: NOW,
        }),
    ],
    [
      "mint: a bad instant",
      () =>
        mintInvitationToken(noSql, {
          id: ID,
          sendSeq: 1,
          hash: HASH,
          now: NEEDLE,
        }),
    ],
    ["expire: a bad id", () => expireInvitation(noSql, NEEDLE, NOW)],
    ["settings: a bad org", () => invitationMessageSettings(noSql, NEEDLE)],
    [
      "address: a bad instant",
      () => pendingInvitationAddress(noSql, ID, NEEDLE),
    ],
    [
      "revoke: a bad reason",
      () =>
        revokePendingInvitations(noSql, {
          orgId: ORG,
          scope: { allInOrg: true },
          reason: NEEDLE as never,
          by: null,
          now: NOW,
        }),
    ],
    [
      "revoke: a bad scope id",
      () =>
        revokePendingInvitations(noSql, {
          orgId: ORG,
          scope: { invitedBy: NEEDLE },
          reason: "manual",
          by: USER,
          now: NOW,
        }),
    ],
  ])("%s", async (_label, work) => {
    const error = await thrown(work);
    expect(String(error)).not.toContain(NEEDLE);
  });
});

describe("rows", () => {
  test("by hash and due map id, org and inviter; a malformed row is invalid_result", async () => {
    const row = { id: ID, org_id: ORG, invited_by: USER };
    const { tx, seen } = fakeTx([[row], [row, row], [{ ...row, id: 1 }]]);
    expect(await invitationByTokenHash(tx, HASH)).toEqual({
      id: ID,
      orgId: ORG,
      invitedBy: USER,
    });
    expect(await invitationsDue(tx, 10)).toHaveLength(2);
    expect(seen[0]?.sql).toContain("app.invitation_by_token_hash");
    expect(seen[1]?.sql).toContain("app.invitations_due");
    expect(await thrown(() => invitationsDue(tx, 10))).toMatchObject({
      code: "invalid_result",
    });
  });

  test("mint: only a pending, unexpired row on this send; answers the address and end", async () => {
    const { tx, seen } = fakeTx([
      [{ id: ID, email: NEEDLE, expires_at: NOW }],
      [],
    ]);
    expect(
      await mintInvitationToken(tx, {
        id: ID,
        sendSeq: 2,
        hash: HASH,
        now: NOW,
      }),
    ).toEqual({ id: ID, email: NEEDLE, expiresAt: NOW });
    expect(seen[0]?.sql).toMatch(/status = 'pending'/);
    expect(seen[0]?.sql).toMatch(/send_seq = /);
    expect(seen[0]?.sql).toMatch(/expires_at > /);
    expect(
      await mintInvitationToken(tx, {
        id: ID,
        sendSeq: 1,
        hash: HASH,
        now: NOW,
      }),
    ).toBeUndefined();
  });

  test("expire and revoke settle rows, sorted by id; a status outside the table is invalid_result", async () => {
    const settled = (id: string) => ({
      id,
      project_id: null,
      status: "revoked",
      revoke_reason: "org_archived",
    });
    const B = "0199e1b0-0000-7000-8000-0000000000b2";
    const { tx, seen } = fakeTx([
      [settled(B), settled(ID)],
      [{ ...settled(ID), status: "expired", revoke_reason: null }],
      [{ ...settled(ID), status: NEEDLE }],
    ]);
    const revoked = await revokePendingInvitations(tx, {
      orgId: ORG,
      scope: { allInOrg: true },
      reason: "org_archived",
      by: null,
      now: NOW,
    });
    expect(revoked.map((r) => r.id)).toEqual([ID, B]);
    expect(seen[0]?.sql).not.toMatch(/invited_by =|project_id =/);
    expect(await expireInvitation(tx, ID, NOW)).toMatchObject({
      status: "expired",
    });
    const error = await thrown(() => expireInvitation(tx, ID, NOW));
    expect(error).toMatchObject({ code: "invalid_result" });
    expect(String(error)).not.toContain(NEEDLE);
  });

  test("a scoped revoke names its column", async () => {
    const { tx, seen } = fakeTx([[], []]);
    await revokePendingInvitations(tx, {
      orgId: ORG,
      scope: { invitedBy: USER },
      reason: "inviter_removed",
      by: USER,
      now: NOW,
    });
    await revokePendingInvitations(tx, {
      orgId: ORG,
      scope: { projectId: ID },
      reason: "project_archived",
      by: USER,
      now: NOW,
    });
    expect(seen[0]?.sql).toMatch(/invited_by = /);
    expect(seen[1]?.sql).toMatch(/project_id = /);
  });

  test("settings and the pending address: a row, none, or invalid_result", async () => {
    const { tx } = fakeTx([
      [{ language: "fr", timezone: "Africa/Freetown" }],
      [],
      [{ language: 1, timezone: "x" }],
      [{ email: NEEDLE, expires_at: NOW }],
      [],
      [{ email: null, expires_at: NOW }],
    ]);
    expect(await invitationMessageSettings(tx, ORG)).toEqual({
      language: "fr",
      timezone: "Africa/Freetown",
    });
    expect(await invitationMessageSettings(tx, ORG)).toBeUndefined();
    expect(
      await thrown(() => invitationMessageSettings(tx, ORG)),
    ).toBeInstanceOf(InvitationError);
    expect(await pendingInvitationAddress(tx, ID, NOW)).toEqual({
      email: NEEDLE,
      expiresAt: NOW,
    });
    expect(await pendingInvitationAddress(tx, ID, NOW)).toBeUndefined();
    expect(
      await thrown(() => pendingInvitationAddress(tx, ID, NOW)),
    ).toBeInstanceOf(InvitationError);
  });

  test("InvitationError names itself", () => {
    expect(new InvitationError("invalid_id").name).toBe("InvitationError");
  });
});
