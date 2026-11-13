// P6-06c (ADR 0085; owner answers Q1, Q6, Q7; conditions C4, C5): migration
// 0015 against a real Postgres 18.
// - expand only: from a database at 0014 with an org, its owner and a
//   member, every old row is still there; a second migrate is a no-op.
// - bricx.ownership_transfers: FORCE RLS (another org reads nothing),
//   bricx_app may UPDATE exactly the listed columns (42501 otherwise), the
//   CHECKs (23514: requester <> approver, Q1; settled columns together;
//   cancel reason), one pending transfer per org (23505), and the guard
//   (P606C, every role, the superuser included): inserted pending, terms
//   never change, a settled row is final, only the recipient accepts a
//   live transfer, and accepted_xact is written by the guard alone.
// - bricx.memberships_guard v2 (Q6, P606C): a role change to or from the
//   owner role passes only in the transaction that accepted a transfer, and
//   only as that transfer says; a later transaction, another member or
//   another role is refused. (d) (Q7, fail-closed): a second open owner is
//   refused on INSERT or reopen for bricx_app and bricx_relay (the guard
//   itself, not only the missing privilege) and allowed for the superuser
//   and bricx_owner; the first owner of an empty org is allowed for
//   bricx_app (the bootstrap and the seed); a removed owner row and an
//   ON CONFLICT DO NOTHING of the existing row pass; a second owner row
//   with a different id does not.
// - bricx.invitation_batches and bricx.invitation_batch_rows: FORCE RLS,
//   column grants, one queued or running batch per org (23505), and the
//   guards (P606D): a row never names the owner role, its inputs never
//   change, a settled row is final, the address only becomes NULL with
//   the settlement; a batch keeps its identity and a done batch is final.
// - app.mfa_state() v4: the recipient of a pending, unexpired transfer
//   needs MFA; after expiry, decline or cancel they do not (when they hold
//   no other trigger).
// - app.ownership_transfers_due() and app.invitation_batches_stale():
//   SECURITY DEFINER, pinned search_path, EXECUTE for bricx_relay only,
//   every org, the right rows, oldest first, capped.
import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type BootstrappedPostgres,
  type Role,
  appDatabase,
  exampleValue,
  rolePasswordKeys,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { seedProject } from "@bricx/db-bootstrap/fixtures";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type Database,
  type RelayDatabase,
  openDatabase,
  openRelayDatabase,
} from "../src/database.js";
import { MIGRATIONS_DIR, migrate } from "../src/migrate.js";
import { mfaState } from "../src/mfa.js";
import {
  INVITATION_BATCH_APP_COLUMNS,
  INVITATION_BATCH_ROW_APP_COLUMNS,
  OWNERSHIP_TRANSFER_APP_COLUMNS,
} from "../src/rls.js";

const NOW = "2026-11-12T12:00:00.000Z";
const CHECK = "23514";
const UNIQUE = "23505";
const DENIED = "42501";
const OWNERSHIP = "P606C";
const BATCH = "P606D";

let pg18: BootstrappedPostgres;
let app: Database;
let relay: RelayDatabase;
let n = 0;
const nextId = (): string => {
  n += 1;
  return `0199e1d9-${n.toString(16).padStart(4, "0")}-7000-8000-${randomUUID().slice(-12)}`;
};

const urlFor = (role: Role) => ({
  reveal: () =>
    `postgres://${role}:${exampleValue(rolePasswordKeys[role])}@${pg18.container.getHost()}:${String(pg18.container.getMappedPort(5432))}/${appDatabase}`,
});

async function asAdmin<R extends pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  const admin = await pg18.admin();
  try {
    return (await admin.query<R>(text, params)).rows;
  } finally {
    await admin.end();
  }
}

/** Statements on one connection in one transaction; rolled back on error, or always when `rollback`. */
async function inTx(
  client: pg.Client,
  statements: readonly (readonly [string, unknown[]?])[],
  rollback = false,
): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const [text, params] of statements) {
      await client.query(text, params ?? []);
    }
    await client.query(rollback ? "ROLLBACK" : "COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function adminTx(
  statements: readonly (readonly [string, unknown[]?])[],
  rollback = false,
): Promise<void> {
  const admin = await pg18.admin();
  try {
    await inTx(admin, statements, rollback);
  } finally {
    await admin.end();
  }
}

async function ownerTx(
  statements: readonly (readonly [string, unknown[]?])[],
): Promise<void> {
  const client = new pg.Client({
    connectionString: urlFor("bricx_owner").reveal(),
  });
  await client.connect();
  try {
    await inTx(client, statements);
  } finally {
    await client.end();
  }
}

/** The SQLSTATE a statement fails with ("none" when it succeeds). */
async function sqlStateOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    let at: unknown = error;
    for (let depth = 0; depth < 5 && at !== undefined; depth += 1) {
      const code = (at as { code?: unknown }).code;
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
      at = (at as { cause?: unknown }).cause;
    }
    return "unknown";
  }
  return "none";
}
const adminState = (text: string, params: unknown[] = []) =>
  sqlStateOf(() => asAdmin(text, params));

/** The production migrations up to and including 0014, in a temp folder. */
async function migrationsThrough0014(): Promise<string> {
  const journal = JSON.parse(
    await readFile(path.join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string }[] };
  const entries = journal.entries.filter((e) => e.idx <= 14);
  expect(entries.at(-1)?.idx).toBe(14);
  const dir = await mkdtemp(path.join(os.tmpdir(), "bricx-0014-"));
  await mkdir(path.join(dir, "meta"));
  await writeFile(
    path.join(dir, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }, null, 2),
  );
  for (const e of entries) {
    await copyFile(
      path.join(MIGRATIONS_DIR, `${e.tag}.sql`),
      path.join(dir, `${e.tag}.sql`),
    );
  }
  return dir;
}

const org = { a: "", b: "", empty: "" };
const project = { a: "" };
const role = {
  ownerA: "",
  crewA: "",
  adminA: "",
  ownerB: "",
  crewB: "",
  ownerEmpty: "",
};
const user = { owner: "", crew: "", other: "", ownerB: "" };
const membership = { owner: "", crew: "", other: "" };

async function seedOrg(id: string, slug: string): Promise<void> {
  await asAdmin(
    `INSERT INTO bricx.organizations
       (id, slug, legal_name, country, default_currency, default_language,
        timezone, units, data_region, created_at, updated_at)
     VALUES ($1, $2, $2, 'SL', 'SLE', 'en', 'Africa/Freetown', 'metric',
        'af-south-1', $3, $3)`,
    [id, slug, NOW],
  );
}

async function seedRole(
  orgId: string,
  key: string,
  systemKey: string | null,
): Promise<string> {
  const id = nextId();
  await asAdmin(
    `INSERT INTO bricx.roles (id, org_id, key, name, system_key, created_at, updated_at)
     VALUES ($1, $2, $3, $3, $4, $5, $5)`,
    [id, orgId, key, systemKey, NOW],
  );
  return id;
}

async function seedUser(label: string): Promise<string> {
  const id = nextId();
  await asAdmin(
    `INSERT INTO bricx.users (id, keycloak_sub, created_at, last_seen_at)
     VALUES ($1, $2, $3, $3)`,
    [id, `m15-${label}-${id.slice(-6)}`, NOW],
  );
  return id;
}

/** One org membership as the superuser; extra columns by name. */
async function member(
  orgId: string,
  userId: string,
  roleId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const id = nextId();
  const names = Object.keys(extra);
  await asAdmin(
    `INSERT INTO bricx.memberships (id, org_id, user_id, role_id, created_at${names.map((c) => `, ${c}`).join("")})
     VALUES ($1, $2, $3, $4, $5${names.map((_, i) => `, $${String(i + 6)}`).join("")})`,
    [id, orgId, userId, roleId, NOW, ...Object.values(extra)],
  );
  return id;
}

/** A pending transfer as the superuser; times relative to the database clock. */
async function transfer(
  orgId: string,
  from: string,
  to: string,
  previousRoleId: string,
  times: { created?: string; expires?: string } = {},
): Promise<string> {
  const id = nextId();
  await asAdmin(
    `INSERT INTO bricx.ownership_transfers
       (id, org_id, initiated_by, to_user_id, previous_owner_role_id, expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5,
       now() + $6::interval, now() + $7::interval, now() + $7::interval)`,
    [
      id,
      orgId,
      from,
      to,
      previousRoleId,
      times.expires ?? "1 day",
      times.created ?? "0 seconds",
    ],
  );
  return id;
}

const ACCEPT = `UPDATE bricx.ownership_transfers
  SET status = 'accepted', settled_by = $2, settled_at = now(), updated_at = now()
  WHERE id = $1`;
const CANCEL = `UPDATE bricx.ownership_transfers
  SET status = 'cancelled', settled_by = $2, settled_at = now(), updated_at = now(), cancel_reason = 'manual'
  WHERE id = $1`;

/** As bricx_app, in one transaction for `userId` in `orgId`. */
const asApp = (
  orgId: string,
  userId: string,
  work: (
    tx: Parameters<Parameters<Database["withTx"]>[1]>[0],
  ) => Promise<unknown>,
) =>
  sqlStateOf(() =>
    app.withTx({ orgId, userId, projectIds: [] }, async (tx) => {
      await work(tx);
    }),
  );

async function roleOf(membershipId: string): Promise<string | undefined> {
  const [row] = await asAdmin<{ role_id: string }>(
    "SELECT role_id::text FROM bricx.memberships WHERE id = $1",
    [membershipId],
  );
  return row?.role_id;
}

beforeAll(async () => {
  pg18 = await startPostgres();
  await migrate(urlFor("bricx_owner"), await migrationsThrough0014());
  org.a = nextId();
  org.b = nextId();
  org.empty = nextId();
  await seedOrg(org.a, "m15-a");
  await seedOrg(org.b, "m15-b");
  await seedOrg(org.empty, "m15-empty");
  role.ownerA = await seedRole(org.a, "owner", "owner");
  role.crewA = await seedRole(org.a, "crew", null);
  role.adminA = await seedRole(org.a, "admin", null);
  role.ownerB = await seedRole(org.b, "owner", "owner");
  role.crewB = await seedRole(org.b, "crew", null);
  role.ownerEmpty = await seedRole(org.empty, "owner", "owner");
  for (const key of Object.keys(user) as (keyof typeof user)[]) {
    user[key] = await seedUser(key);
  }
  project.a = nextId();
  await seedProject(asAdmin, org.a, project.a);
  // Rows of the 0014 shape.
  membership.owner = await member(org.a, user.owner, role.ownerA);
  membership.crew = await member(org.a, user.crew, role.crewA);
  membership.other = await member(org.a, user.other, role.crewA);
  await member(org.b, user.ownerB, role.ownerB);
  await migrate(urlFor("bricx_owner"));
  app = openDatabase(urlFor("bricx_app"));
  relay = openRelayDatabase(urlFor("bricx_relay"));
}, 300_000);
afterAll(async () => {
  await app.close().catch(() => undefined);
  await relay.close().catch(() => undefined);
  await pg18.container.stop();
});

describe("expand only", () => {
  test("rows written at 0014 are unchanged; a second migrate is a no-op", async () => {
    expect(
      await asAdmin(
        "SELECT id::text, role_id::text FROM bricx.memberships WHERE org_id = $1 ORDER BY id",
        [org.a],
      ),
    ).toEqual(
      [
        { id: membership.owner, role_id: role.ownerA },
        { id: membership.crew, role_id: role.crewA },
        { id: membership.other, role_id: role.crewA },
      ].sort((x, y) => x.id.localeCompare(y.id)),
    );
    const ledger = () =>
      asAdmin<{ r: string }>(
        "SELECT idx || ':' || tag AS r FROM bricx_migrations.applied ORDER BY idx",
      );
    const applied = await ledger();
    await migrate(urlFor("bricx_owner"));
    expect(await ledger()).toEqual(applied);
    expect(applied.map((a) => a.r)).toContain("15:0015_ownership_bulk_invite");
  });
});

describe("tables: FORCE RLS and column grants", () => {
  test("the three tables have FORCE RLS; bricx_app may UPDATE exactly the listed columns", async () => {
    const tables = {
      ownership_transfers: OWNERSHIP_TRANSFER_APP_COLUMNS,
      invitation_batches: INVITATION_BATCH_APP_COLUMNS,
      invitation_batch_rows: INVITATION_BATCH_ROW_APP_COLUMNS,
    } as const;
    for (const [table, columns] of Object.entries(tables)) {
      expect(
        await asAdmin(
          `SELECT relrowsecurity AS rls, relforcerowsecurity AS force
           FROM pg_class WHERE oid = $1::regclass`,
          [`bricx.${table}`],
        ),
      ).toEqual([{ rls: true, force: true }]);
      const granted = await asAdmin<{ column: string }>(
        `SELECT a.attname AS column FROM pg_attribute a
         WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
           AND has_column_privilege('bricx_app', a.attrelid, a.attnum, 'UPDATE')
         ORDER BY 1`,
        [`bricx.${table}`],
      );
      expect(granted.map((r) => r.column)).toEqual([...columns].sort());
      // No DELETE policy for anyone: a DELETE matches no row under FORCE.
      expect(
        await asAdmin(
          `SELECT count(*)::int AS n FROM pg_policies
           WHERE schemaname = 'bricx' AND tablename = $1 AND cmd IN ('DELETE', 'ALL')`,
          [table],
        ),
      ).toEqual([{ n: 0 }]);
    }
  });

  test("bricx_app in org B reads none of org A's transfers; 42501 on a term column", async () => {
    const id = await transfer(org.a, user.owner, user.crew, role.crewA);
    let seen = -1;
    expect(
      await asApp(org.b, user.ownerB, async (tx) => {
        seen = (
          await tx.execute(
            sql`SELECT id FROM bricx.ownership_transfers WHERE id = ${id}::uuid`,
          )
        ).rows.length;
      }),
    ).toBe("none");
    expect(seen).toBe(0);
    for (const assignment of [
      sql`to_user_id = ${user.other}::uuid`,
      sql`expires_at = now() + interval '2 days'`,
      sql`initiated_by = ${user.crew}::uuid`,
    ]) {
      expect(
        await asApp(org.a, user.owner, (tx) =>
          tx.execute(
            sql`UPDATE bricx.ownership_transfers SET ${assignment} WHERE id = ${id}::uuid`,
          ),
        ),
      ).toBe(DENIED);
    }
    await asAdmin(CANCEL, [id, user.owner]);
  });
});

describe("bricx.ownership_transfers: CHECKs, one pending per org, the guard (P606C)", () => {
  test("the requester is never the recipient (Q1, 23514); a second pending transfer is 23505; a cancellation needs a reason", async () => {
    expect(
      await sqlStateOf(() =>
        transfer(org.a, user.owner, user.owner, role.crewA),
      ),
    ).toBe(CHECK);
    const first = await transfer(org.a, user.owner, user.crew, role.crewA);
    expect(
      await sqlStateOf(() =>
        transfer(org.a, user.owner, user.other, role.crewA),
      ),
    ).toBe(UNIQUE);
    // Another org is not blocked.
    const inB = await transfer(org.b, user.ownerB, user.owner, role.crewB);
    expect(
      await adminState(
        `UPDATE bricx.ownership_transfers SET status = 'cancelled', settled_by = $2,
           settled_at = now(), updated_at = now() WHERE id = $1`,
        [first, user.owner],
      ),
    ).toBe(CHECK);
    expect(await adminState(CANCEL, [first, user.owner])).toBe("none");
    await asAdmin(CANCEL, [inB, user.ownerB]);
  });

  test("inserted pending only; terms never change; a settled row is final; accepted_xact belongs to the guard (superuser included)", async () => {
    const id = nextId();
    expect(
      await adminState(
        `INSERT INTO bricx.ownership_transfers
           (id, org_id, initiated_by, to_user_id, previous_owner_role_id, status, expires_at, created_at, updated_at, settled_by, settled_at)
         VALUES ($1, $2, $3, $4, $5, 'declined', now() + interval '1 day', now(), now(), $4, now())`,
        [id, org.a, user.owner, user.crew, role.crewA],
      ),
    ).toBe(OWNERSHIP);
    const live = await transfer(org.a, user.owner, user.crew, role.crewA);
    for (const assignment of [
      `to_user_id = '${user.other}'`,
      `initiated_by = '${user.crew}'`,
      `previous_owner_role_id = '${role.adminA}'`,
      "expires_at = expires_at + interval '1 hour'",
      "created_at = created_at - interval '1 hour'",
      "accepted_xact = pg_current_xact_id()",
    ]) {
      expect(
        await adminState(
          `UPDATE bricx.ownership_transfers SET ${assignment} WHERE id = $1`,
          [live],
        ),
      ).toBe(OWNERSHIP);
    }
    // The superuser cannot accept without being the recipient.
    expect(await adminState(ACCEPT, [live, user.crew])).toBe(OWNERSHIP);
    expect(await adminState(CANCEL, [live, user.owner])).toBe("none");
    // Final: no status, no reason, no reopening.
    for (const assignment of [
      "status = 'pending', settled_by = NULL, settled_at = NULL, cancel_reason = NULL",
      "cancel_reason = 'org_archived'",
      "updated_at = now()",
    ]) {
      expect(
        await adminState(
          `UPDATE bricx.ownership_transfers SET ${assignment} WHERE id = $1`,
          [live],
        ),
      ).toBe(OWNERSHIP);
    }
  });

  test("only the recipient accepts, and only while the transfer is live; the guard records the accepting transaction", async () => {
    const id = await transfer(org.a, user.owner, user.crew, role.crewA);
    // The initiator (or anyone else) accepting: refused (Q1).
    expect(
      await asApp(org.a, user.owner, (tx) =>
        tx.execute(
          sql`UPDATE bricx.ownership_transfers SET status = 'accepted', settled_by = ${user.crew}::uuid, settled_at = now(), updated_at = now() WHERE id = ${id}::uuid`,
        ),
      ),
    ).toBe(OWNERSHIP);
    // settled_by must be the recipient (CHECK) ...
    expect(
      await asApp(org.a, user.crew, (tx) =>
        tx.execute(
          sql`UPDATE bricx.ownership_transfers SET status = 'accepted', settled_by = ${user.owner}::uuid, settled_at = now(), updated_at = now() WHERE id = ${id}::uuid`,
        ),
      ),
    ).not.toBe("none");
    // ... and the recipient accepting the live transfer passes; the
    // membership change is NOT made here, so the transfer alone settles.
    let xact = "";
    expect(
      await asApp(org.a, user.crew, async (tx) => {
        await tx.execute(
          sql`UPDATE bricx.ownership_transfers SET status = 'accepted', settled_by = ${user.crew}::uuid, settled_at = now(), updated_at = now() WHERE id = ${id}::uuid`,
        );
        xact = String(
          (
            await tx.execute<{ x: string }>(
              sql`SELECT pg_current_xact_id()::text AS x`,
            )
          ).rows[0]?.x,
        );
      }),
    ).toBe("none");
    expect(
      await asAdmin(
        "SELECT status, accepted_xact::text AS xact FROM bricx.ownership_transfers WHERE id = $1",
        [id],
      ),
    ).toEqual([{ status: "accepted", xact }]);
    // An expired transfer is not accepted, even by the recipient.
    const old = await transfer(org.a, user.owner, user.other, role.crewA, {
      created: "-2 days",
      expires: "-1 day",
    });
    expect(
      await asApp(org.a, user.other, (tx) =>
        tx.execute(
          sql`UPDATE bricx.ownership_transfers SET status = 'accepted', settled_by = ${user.other}::uuid, settled_at = now(), updated_at = now() WHERE id = ${old}::uuid`,
        ),
      ),
    ).toBe(OWNERSHIP);
    await asAdmin(
      `UPDATE bricx.ownership_transfers SET status = 'expired', settled_at = now(), updated_at = now() WHERE id = $1`,
      [old],
    );
  });
});

describe("bricx.memberships_guard v2: ownership changes only by a transfer (Q6, P606C)", () => {
  test("a bare promotion or demotion is refused for every role; in the accepting transaction exactly the transfer's two changes pass; a later transaction does not", async () => {
    const setRole = (id: string, roleId: string) =>
      adminState("UPDATE bricx.memberships SET role_id = $2 WHERE id = $1", [
        id,
        roleId,
      ]);
    expect(await setRole(membership.other, role.ownerA)).toBe(OWNERSHIP);
    expect(await setRole(membership.owner, role.crewA)).toBe(OWNERSHIP);
    expect(
      await asApp(org.a, user.owner, (tx) =>
        tx.execute(
          sql`UPDATE bricx.memberships SET role_id = ${role.ownerA}::uuid WHERE id = ${membership.other}::uuid`,
        ),
      ),
    ).toBe(OWNERSHIP);
    // bricx_owner (the migration role) is refused the same way.
    expect(
      await sqlStateOf(() =>
        ownerTx([
          ["SELECT set_config('app.org_id', $1, true)", [org.a]],
          [
            "UPDATE bricx.memberships SET role_id = $2 WHERE id = $1",
            [membership.other, role.ownerA],
          ],
        ]),
      ),
    ).toBe(OWNERSHIP);
    // A non-owner role change is untouched.
    expect(await setRole(membership.other, role.adminA)).toBe("none");
    expect(await setRole(membership.other, role.crewA)).toBe("none");

    const id = await transfer(org.a, user.owner, user.other, role.adminA);
    const accept = sql`UPDATE bricx.ownership_transfers SET status = 'accepted', settled_by = ${user.other}::uuid, settled_at = now(), updated_at = now() WHERE id = ${id}::uuid`;
    const promote = (membershipId: string) =>
      sql`UPDATE bricx.memberships SET role_id = ${role.ownerA}::uuid WHERE id = ${membershipId}::uuid`;
    const demote = (roleId: string) =>
      sql`UPDATE bricx.memberships SET role_id = ${roleId}::uuid WHERE id = ${membership.owner}::uuid`;
    // In the accepting transaction: another member is not promoted ...
    expect(
      await asApp(org.a, user.other, async (tx) => {
        await tx.execute(accept);
        await tx.execute(promote(membership.crew));
      }),
    ).toBe(OWNERSHIP);
    // ... the initiator gets only previous_owner_role_id ...
    expect(
      await asApp(org.a, user.other, async (tx) => {
        await tx.execute(accept);
        await tx.execute(promote(membership.other));
        await tx.execute(demote(role.crewA));
      }),
    ).toBe(OWNERSHIP);
    // (both rolled back: the transfer is still pending)
    expect(
      await asAdmin(
        "SELECT status FROM bricx.ownership_transfers WHERE id = $1",
        [id],
      ),
    ).toEqual([{ status: "pending" }]);
    // ... and exactly the transfer's changes pass.
    expect(
      await asApp(org.a, user.other, async (tx) => {
        await tx.execute(accept);
        await tx.execute(promote(membership.other));
        await tx.execute(demote(role.adminA));
      }),
    ).toBe("none");
    expect(await roleOf(membership.other)).toBe(role.ownerA);
    expect(await roleOf(membership.owner)).toBe(role.adminA);
    // A later transaction is not the accepting one: refused again.
    expect(await setRole(membership.owner, role.ownerA)).toBe(OWNERSHIP);
    expect(
      await asApp(org.a, user.other, (tx) =>
        tx.execute(
          sql`UPDATE bricx.memberships SET role_id = ${role.ownerA}::uuid WHERE id = ${membership.crew}::uuid`,
        ),
      ),
    ).toBe(OWNERSHIP);
    // Hand ownership back for the tests below (sanctioned path again).
    const back = await transfer(org.a, user.other, user.owner, role.crewA);
    expect(
      await asApp(org.a, user.owner, async (tx) => {
        await tx.execute(
          sql`UPDATE bricx.ownership_transfers SET status = 'accepted', settled_by = ${user.owner}::uuid, settled_at = now(), updated_at = now() WHERE id = ${back}::uuid`,
        );
        await tx.execute(promote(membership.owner));
        await tx.execute(
          sql`UPDATE bricx.memberships SET role_id = ${role.crewA}::uuid WHERE id = ${membership.other}::uuid`,
        );
      }),
    ).toBe("none");
    expect(await roleOf(membership.owner)).toBe(role.ownerA);
  });

  test("(d) a second open owner: refused for bricx_app and bricx_relay, allowed for the superuser and bricx_owner (Q7)", async () => {
    const newcomer = await seedUser("d-app");
    const insert = (id: string, userId: string) =>
      sql`INSERT INTO bricx.memberships (id, org_id, user_id, role_id, created_at)
          VALUES (${id}::uuid, ${org.a}::uuid, ${userId}::uuid, ${role.ownerA}::uuid, now())`;
    expect(
      await asApp(org.a, user.owner, (tx) =>
        tx.execute(insert(nextId(), newcomer)),
      ),
    ).toBe(OWNERSHIP);
    // bricx_relay: refused by the missing privilege ...
    expect(
      await sqlStateOf(() =>
        relay.withRelayTx((tx) => tx.execute(insert(nextId(), newcomer))),
      ),
    ).toBe(DENIED);
    // ... and by the guard itself, given the privileges and policies for
    // the length of one rolled-back transaction: when bricx_relay cannot
    // see the org's roles (fail-closed: an unseen role is refused) and
    // when it can (another open owner exists).
    const probe = (rolesVisible: boolean) =>
      sqlStateOf(() =>
        adminTx(
          [
            ["GRANT INSERT ON bricx.memberships TO bricx_relay"],
            ["GRANT SELECT ON bricx.roles, bricx.memberships TO bricx_relay"],
            [
              "CREATE POLICY m15_probe ON bricx.memberships FOR INSERT TO bricx_relay WITH CHECK (true)",
            ],
            ...(rolesVisible
              ? ([
                  [
                    "CREATE POLICY m15_probe_r ON bricx.roles FOR SELECT TO bricx_relay USING (true)",
                  ],
                  [
                    "CREATE POLICY m15_probe_m ON bricx.memberships FOR SELECT TO bricx_relay USING (true)",
                  ],
                ] as const)
              : []),
            ["SET LOCAL ROLE bricx_relay"],
            [
              `INSERT INTO bricx.memberships (id, org_id, user_id, role_id, created_at)
               VALUES ($1, $2, $3, $4, now())`,
              [nextId(), org.a, newcomer, role.ownerA],
            ],
          ],
          true,
        ),
      );
    expect(await probe(false)).toBe(OWNERSHIP);
    expect(await probe(true)).toBe(OWNERSHIP);
    expect(
      await asAdmin(
        "SELECT has_table_privilege('bricx_relay', 'bricx.memberships', 'INSERT') AS i",
      ),
    ).toEqual([{ i: false }]);
    // bricx_owner (migrations) and the superuser (fixtures) may.
    const viaOwner = nextId();
    expect(
      await sqlStateOf(() =>
        ownerTx([
          ["SELECT set_config('app.org_id', $1, true)", [org.a]],
          [
            `INSERT INTO bricx.memberships (id, org_id, user_id, role_id, created_at)
             VALUES ($1, $2, $3, $4, now())`,
            [viaOwner, org.a, newcomer, role.ownerA],
          ],
        ]),
      ),
    ).toBe("none");
    const fixtureUser = await seedUser("d-admin");
    const viaAdmin = await sqlStateOf(() =>
      member(org.a, fixtureUser, role.ownerA),
    );
    expect(viaAdmin).toBe("none");
  });

  test("(d) the first owner of an empty org passes for bricx_app (bootstrap, seed); the row itself and a removed owner row pass; a second row with another id does not; reopening a removed owner does not", async () => {
    const first = nextId();
    const founder = await seedUser("founder");
    const insert = (id: string, userId: string, removed = false) =>
      sql`INSERT INTO bricx.memberships (id, org_id, user_id, role_id, created_at, removed_at)
          VALUES (${id}::uuid, ${org.empty}::uuid, ${userId}::uuid, ${role.ownerEmpty}::uuid, now(),
            ${removed ? sql`now()` : sql`NULL`})
          ON CONFLICT DO NOTHING`;
    expect(
      await asApp(org.empty, founder, (tx) =>
        tx.execute(insert(first, founder)),
      ),
    ).toBe("none");
    // The seed's second run: the same row again, ON CONFLICT DO NOTHING.
    expect(
      await asApp(org.empty, founder, (tx) =>
        tx.execute(insert(first, founder)),
      ),
    ).toBe("none");
    // A second owner row with a different id, even ON CONFLICT DO NOTHING.
    const second = await seedUser("second");
    expect(
      await asApp(org.empty, founder, (tx) =>
        tx.execute(insert(nextId(), second)),
      ),
    ).toBe(OWNERSHIP);
    // A removed owner row is not an open owner.
    const removed = nextId();
    expect(
      await asApp(org.empty, founder, (tx) =>
        tx.execute(insert(removed, second, true)),
      ),
    ).toBe("none");
    // Reopening it while the founder is open: refused.
    expect(
      await asApp(org.empty, founder, (tx) =>
        tx.execute(
          sql`UPDATE bricx.memberships SET removed_at = NULL WHERE id = ${removed}::uuid`,
        ),
      ),
    ).toBe(OWNERSHIP);
    expect(
      await asAdmin(
        `SELECT count(*)::int AS open FROM bricx.memberships
         WHERE org_id = $1 AND removed_at IS NULL`,
        [org.empty],
      ),
    ).toEqual([{ open: 1 }]);
  });
});

describe("bricx.invitation_batches and bricx.invitation_batch_rows (P606D)", () => {
  const batchAt = async (
    orgId: string,
    createdBy: string,
    created = "0 seconds",
  ): Promise<string> => {
    const id = nextId();
    await asAdmin(
      `INSERT INTO bricx.invitation_batches (id, org_id, created_by, row_count, created_at, updated_at)
       VALUES ($1, $2, $3, 2, now() + $4::interval, now() + $4::interval)`,
      [id, orgId, createdBy, created],
    );
    return id;
  };
  const row = (
    batchId: string,
    rowNo: number,
    roleId: string,
    email = `r${String(rowNo)}@site.example`,
  ) =>
    asAdmin(
      `INSERT INTO bricx.invitation_batch_rows (org_id, batch_id, row_no, email_normalised, role_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [org.a, batchId, rowNo, email, roleId],
    );
  const done = (batchId: string) =>
    asAdmin(
      "UPDATE bricx.invitation_batches SET status = 'done', updated_at = now() WHERE id = $1",
      [batchId],
    );

  test("one queued or running batch per org; a row never names the owner role; inputs never change; the address goes only with the settlement; settled and done are final", async () => {
    const batch = await batchAt(org.a, user.owner);
    expect(await sqlStateOf(() => batchAt(org.a, user.owner))).toBe(UNIQUE);
    expect(await sqlStateOf(() => row(batch, 1, role.ownerA))).toBe(BATCH);
    await row(batch, 1, role.crewA);
    await row(batch, 2, role.crewA, "Upper@site.example".toLowerCase());
    for (const assignment of [
      `role_id = '${role.adminA}'`,
      "is_external = true",
      "row_no = 3",
    ]) {
      expect(
        await adminState(
          `UPDATE bricx.invitation_batch_rows SET ${assignment} WHERE batch_id = $1 AND row_no = 1`,
          [batch],
        ),
      ).toBe(BATCH);
    }
    // The address does not change on its own, and not to NULL while pending.
    expect(
      await adminState(
        "UPDATE bricx.invitation_batch_rows SET email_normalised = 'x@site.example' WHERE batch_id = $1 AND row_no = 1",
        [batch],
      ),
    ).toBe(BATCH);
    expect(
      await adminState(
        "UPDATE bricx.invitation_batch_rows SET email_normalised = NULL WHERE batch_id = $1 AND row_no = 1",
        [batch],
      ),
    ).not.toBe("none");
    // Settlement clears it, as bricx_app.
    expect(
      await asApp(org.a, user.owner, (tx) =>
        tx.execute(
          sql`UPDATE bricx.invitation_batch_rows SET status = 'failed', error_code = 'pending_exists', email_normalised = NULL, updated_at = now()
              WHERE batch_id = ${batch}::uuid AND row_no = 1`,
        ),
      ),
    ).toBe("none");
    // A failed row keeping its address breaks the CHECK.
    expect(
      await adminState(
        "UPDATE bricx.invitation_batch_rows SET status = 'failed', error_code = 'conflict', updated_at = now() WHERE batch_id = $1 AND row_no = 2",
        [batch],
      ),
    ).toBe(CHECK);
    expect(
      await adminState(
        "UPDATE bricx.invitation_batch_rows SET error_code = 'conflict' WHERE batch_id = $1 AND row_no = 1",
        [batch],
      ),
    ).toBe(BATCH);
    // A batch keeps its identity; done is final.
    expect(
      await adminState(
        "UPDATE bricx.invitation_batches SET row_count = 3 WHERE id = $1",
        [batch],
      ),
    ).toBe(BATCH);
    await done(batch);
    expect(
      await adminState(
        "UPDATE bricx.invitation_batches SET status = 'running' WHERE id = $1",
        [batch],
      ),
    ).toBe(BATCH);
    // Another batch may start now.
    await done(await batchAt(org.a, user.owner));
  });

  test("a pending row names its role; a row refused at submission keeps no inputs (role NULL, address NULL, failed with its code)", async () => {
    const batch = await batchAt(org.a, user.owner);
    expect(
      await sqlStateOf(() =>
        asAdmin(
          `INSERT INTO bricx.invitation_batch_rows (org_id, batch_id, row_no, email_normalised, updated_at)
           VALUES ($1, $2, 1, 'r1@site.example', now())`,
          [org.a, batch],
        ),
      ),
    ).toBe(CHECK);
    await asAdmin(
      `INSERT INTO bricx.invitation_batch_rows (org_id, batch_id, row_no, status, error_code, updated_at)
       VALUES ($1, $2, 1, 'failed', 'owner_role', now())`,
      [org.a, batch],
    );
    await done(batch);
  });

  test("bricx_app in org B reads none of org A's batch rows", async () => {
    const batch = await batchAt(org.a, user.owner);
    await row(batch, 1, role.crewA);
    let seen = -1;
    expect(
      await asApp(org.b, user.ownerB, async (tx) => {
        seen = (
          await tx.execute(
            sql`SELECT 1 FROM bricx.invitation_batch_rows WHERE batch_id = ${batch}::uuid
                UNION ALL SELECT 1 FROM bricx.invitation_batches WHERE id = ${batch}::uuid`,
          )
        ).rows.length;
      }),
    ).toBe("none");
    expect(seen).toBe(0);
    await asAdmin(
      `UPDATE bricx.invitation_batch_rows SET status = 'failed', error_code = 'not_processed', email_normalised = NULL, updated_at = now() WHERE batch_id = $1`,
      [batch],
    );
    await done(batch);
  });
});

describe("app.mfa_state() v4", () => {
  test("the recipient of a pending, unexpired transfer needs MFA; after a decline or an expiry they do not", async () => {
    const recipient = await seedUser("mfa");
    await member(org.b, recipient, role.crewB);
    const required = async () =>
      (await relay.withRelayTx((tx) => mfaState(tx, recipient)))?.required;
    expect(await required()).toBe(false);
    const id = await transfer(org.b, user.ownerB, recipient, role.crewB);
    expect(await required()).toBe(true);
    expect(
      await asApp(org.b, recipient, (tx) =>
        tx.execute(
          sql`UPDATE bricx.ownership_transfers SET status = 'declined', settled_by = ${recipient}::uuid, settled_at = now(), updated_at = now() WHERE id = ${id}::uuid`,
        ),
      ),
    ).toBe("none");
    expect(await required()).toBe(false);
    // Pending but past expires_at (the sweep has not run yet): not required.
    const stale = await transfer(org.b, user.ownerB, recipient, role.crewB, {
      created: "-2 days",
      expires: "-1 hour",
    });
    expect(await required()).toBe(false);
    await asAdmin(
      `UPDATE bricx.ownership_transfers SET status = 'expired', settled_at = now(), updated_at = now() WHERE id = $1`,
      [stale],
    );
  });
});

describe("app.ownership_transfers_due() and app.invitation_batches_stale(): the relay's reads", () => {
  test("SECURITY DEFINER, pinned search_path, EXECUTE for bricx_relay only; bricx_app is 42501", async () => {
    for (const sig of [
      "app.ownership_transfers_due(integer)",
      "app.invitation_batches_stale(integer)",
      "app.mfa_transfer_pending(uuid)",
    ]) {
      const [fn] = await asAdmin<{ definer: boolean; config: string[] | null }>(
        "SELECT prosecdef AS definer, proconfig AS config FROM pg_proc WHERE oid = $1::regprocedure",
        [sig],
      );
      expect(fn?.config).toEqual(["search_path=pg_catalog, pg_temp"]);
      expect(fn?.definer).toBe(sig !== "app.mfa_transfer_pending(uuid)");
      expect(
        await asAdmin(
          `SELECT r.rolname AS role FROM pg_roles r
           WHERE r.rolname IN ('bricx_app', 'bricx_readonly', 'bricx_relay', 'powersync_repl')
             AND has_function_privilege(r.oid, $1, 'EXECUTE') ORDER BY 1`,
          [sig],
        ),
      ).toEqual(
        sig === "app.mfa_transfer_pending(uuid)"
          ? []
          : [{ role: "bricx_relay" }],
      );
    }
    for (const statement of [
      sql`SELECT * FROM app.ownership_transfers_due(10)`,
      sql`SELECT * FROM app.invitation_batches_stale(10)`,
    ]) {
      expect(
        await asApp(org.a, user.owner, (tx) => tx.execute(statement)),
      ).toBe(DENIED);
    }
  });

  test("due transfers and stale batches: every org, oldest first, capped; live ones are not listed", async () => {
    const dueA = await transfer(org.a, user.owner, user.crew, role.crewA, {
      created: "-3 days",
      expires: "-2 days",
    });
    const dueB = await transfer(org.b, user.ownerB, user.owner, role.crewB, {
      created: "-3 days",
      expires: "-1 day",
    });
    const due = await relay.withRelayTx(
      async (tx) =>
        (
          await tx.execute<{ id: string; org_id: string; to_user_id: string }>(
            sql`SELECT id::text, org_id::text, to_user_id::text FROM app.ownership_transfers_due(100)`,
          )
        ).rows,
    );
    expect(due).toEqual([
      { id: dueA, org_id: org.a, to_user_id: user.crew },
      { id: dueB, org_id: org.b, to_user_id: user.owner },
    ]);
    for (const limit of [0, -1, null]) {
      expect(
        await relay.withRelayTx(
          async (tx) =>
            (
              await tx.execute(
                sql`SELECT * FROM app.ownership_transfers_due(${limit}::integer)`,
              )
            ).rows,
        ),
      ).toEqual([]);
    }
    expect(
      (
        await relay.withRelayTx(
          async (tx) =>
            (
              await tx.execute(
                sql`SELECT * FROM app.ownership_transfers_due(1)`,
              )
            ).rows,
        )
      ).length,
    ).toBe(1);
    for (const id of [dueA, dueB]) {
      await asAdmin(
        `UPDATE bricx.ownership_transfers SET status = 'expired', settled_at = now(), updated_at = now() WHERE id = $1`,
        [id],
      );
    }

    const staleB = nextId();
    await asAdmin(
      `INSERT INTO bricx.invitation_batches (id, org_id, created_by, row_count, created_at, updated_at)
       VALUES ($1, $2, $3, 1, now() - interval '2 hours', now() - interval '2 hours')`,
      [staleB, org.b, user.ownerB],
    );
    const fresh = nextId();
    await asAdmin(
      `INSERT INTO bricx.invitation_batches (id, org_id, created_by, row_count, created_at, updated_at)
       VALUES ($1, $2, $3, 1, now() - interval '10 minutes', now())`,
      [fresh, org.a, user.owner],
    );
    expect(
      await relay.withRelayTx(
        async (tx) =>
          (
            await tx.execute<{
              id: string;
              org_id: string;
              created_by: string;
            }>(
              sql`SELECT id::text, org_id::text, created_by::text FROM app.invitation_batches_stale(100)`,
            )
          ).rows,
      ),
    ).toEqual([{ id: staleB, org_id: org.b, created_by: user.ownerB }]);
    for (const id of [staleB, fresh]) {
      await asAdmin(
        "UPDATE bricx.invitation_batches SET status = 'done', updated_at = now() WHERE id = $1",
        [id],
      );
    }
  });
});
