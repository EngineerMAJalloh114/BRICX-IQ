// P6-05e (ADR 0081; owner condition C3): migration 0012 makes
// app.mfa_state() v3 count the org-admin keys (@bricx/permissions
// MFA_ADMIN_KEYS, held in SQL by app.mfa_admin_keys()) and backfills one
// users.mfa_check outbox row per user whose v3 answer is true and v2
// answer was false, so the worker maps bricx-mfa for administrators that
// existed before the change.
// - Under FORCE RLS: the migrator is bricx_owner, which has no INSERT
//   policy on bricx.outbox. 0012 creates a narrow owner INSERT policy
//   (topic users.mfa_check only), inserts, and drops it in the same
//   transaction: afterwards the outbox's policies and FORCE are exactly
//   what they were (asserted), and no BYPASSRLS role is involved.
// - Bounded: only admin-by-key users without a finance key (an owner,
//   a finance role holder, a removed membership, an expired or revoked
//   elevation and a plain member get no row).
// - Idempotent: the selection (app.mfa_admin_held AND NOT
//   app.mfa_finance_held) does not depend on which mfa_state version is
//   installed, so a rerun selects the same users again; stable UUIDv7 ids
//   derived from the user id (the relay's BullMQ jobId) and ON CONFLICT DO
//   NOTHING make that rerun add no row.
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
import { seedProject } from "@bricx/db-bootstrap/fixtures";
import {
  type BootstrappedPostgres,
  type Role,
  appDatabase,
  exampleValue,
  rolePasswordKeys,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { MFA_ADMIN_KEYS } from "@bricx/permissions/mfa";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MIGRATIONS_DIR, migrate } from "../src/migrate.js";

const NOW = "2026-11-09T12:00:00.000Z";
const LATER = "2099-01-01T00:00:00.000Z";
const TAG = "0012_mfa_admin_keys";
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let pg18: BootstrappedPostgres;
let n = 0;
const nextId = (): string => {
  n += 1;
  return `0199e1e5-${n.toString(16).padStart(4, "0")}-7000-8000-${randomUUID().slice(-12)}`;
};

const urlFor = (role: Role) =>
  `postgres://${role}:${exampleValue(rolePasswordKeys[role])}@${pg18.container.getHost()}:${String(pg18.container.getMappedPort(5432))}/${appDatabase}`;

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

/** The production migrations up to and including 0011, in a temp folder. */
async function migrationsThrough0011(): Promise<string> {
  const journal = JSON.parse(
    await readFile(path.join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string }[] };
  const entries = journal.entries.filter((e) => e.idx <= 11);
  expect(entries.map((e) => e.idx)).toEqual([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
  ]);
  const dir = await mkdtemp(path.join(os.tmpdir(), "bricx-0011-"));
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

/** 0012's backfill statements, between its backfill markers. */
async function backfillStatements(): Promise<string[]> {
  const text = await readFile(path.join(MIGRATIONS_DIR, `${TAG}.sql`), "utf8");
  const statements = text.split("--> statement-breakpoint");
  const start = statements.findIndex((s) => s.includes("-- backfill:begin"));
  const end = statements.findIndex((s) => s.includes("-- backfill:end"));
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return statements.slice(start, end + 1);
}

const ORG = nextId();
const PROJECT = nextId();
const users = {
  owner: nextId(),
  finance: nextId(),
  adminRole: nextId(),
  adminOverride: nextId(),
  adminGrant: nextId(),
  removed: nextId(),
  expiredGrant: nextId(),
  plain: nextId(),
  adminAndFinance: nextId(),
} as const;

async function role(key: string, permissions: string[], system?: string) {
  const id = nextId();
  await asAdmin(
    `INSERT INTO bricx.roles (id, org_id, key, name, system_key, created_at, updated_at)
     VALUES ($1, $2, $3, $3, $4, $5, $5)`,
    [id, ORG, key, system ?? null, NOW],
  );
  for (const permission of permissions) {
    await asAdmin(
      `INSERT INTO bricx.role_permissions (id, org_id, role_id, permission, granted_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [nextId(), ORG, id, permission, NOW],
    );
  }
  return id;
}

async function member(user: string, roleId: string, removed = false) {
  await asAdmin(
    `INSERT INTO bricx.memberships (id, org_id, user_id, role_id, created_at, removed_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [nextId(), ORG, user, roleId, NOW, removed ? NOW : null],
  );
}

let policiesBefore: unknown[];

beforeAll(async () => {
  pg18 = await startPostgres();
  await migrate(
    { reveal: () => urlFor("bricx_owner") },
    await migrationsThrough0011(),
  );
  await asAdmin(
    `INSERT INTO bricx.organizations
       (id, slug, legal_name, country, default_currency, default_language,
        timezone, units, data_region, created_at, updated_at)
     VALUES ($1, 'backfill', 'Backfill Ltd', 'SL', 'SLE', 'en', 'Africa/Freetown',
        'metric', 'af-south-1', $2, $2)`,
    [ORG, NOW],
  );
  await seedProject(asAdmin, ORG, PROJECT);
  for (const [name, id] of Object.entries(users)) {
    await asAdmin(
      `INSERT INTO bricx.users (id, keycloak_sub, created_at, last_seen_at)
       VALUES ($1, $2, $3, $3)`,
      [id, `sub-${name}`, NOW],
    );
  }
  await member(users.owner, await role("owner", [], "owner"));
  await member(users.finance, await role("acct", ["finance.budget.read.org"]));
  const inviter = await role("inviter", [
    "org.member.invite.org",
    "org.member.read.org",
  ]);
  await member(users.adminRole, inviter);
  await member(users.removed, inviter, true);
  await member(
    users.adminAndFinance,
    await role("both", ["org.role.manage.org", "finance.ledger.read.org"]),
  );
  const reader = await role("reader", ["project.task.read.project"]);
  await member(users.plain, reader);
  // A project membership whose override adds an admin key.
  await asAdmin(
    `INSERT INTO bricx.project_memberships (id, org_id, project_id, user_id, role_id, overrides, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      nextId(),
      ORG,
      PROJECT,
      users.adminOverride,
      reader,
      JSON.stringify({ add: ["project.member.assign.project"] }),
      NOW,
    ],
  );
  const grant = (user: string, permission: string, expired: boolean) =>
    asAdmin(
      `INSERT INTO bricx.access_grants
         (id, org_id, user_id, permission, scope_id, reason, granted_by,
          starts_at, expires_at, created_at, expired_at)
       VALUES ($1, $2, $3, $4, NULL, 'cover', $5, $6, $7, $6, $8)`,
      [
        nextId(),
        ORG,
        user,
        permission,
        users.owner,
        NOW,
        LATER,
        expired ? NOW : null,
      ],
    );
  await grant(users.adminGrant, "org.session.revoke.org", false);
  await grant(users.expiredGrant, "org.session.revoke.org", true);
  policiesBefore = await asAdmin(
    `SELECT policyname, cmd, roles::text, qual, with_check FROM pg_policies
     WHERE schemaname = 'bricx' AND tablename = 'outbox' ORDER BY policyname`,
  );
  // Now 0012, with the rest of the production journal.
  await migrate({ reveal: () => urlFor("bricx_owner") });
}, 300_000);

afterAll(async () => {
  await pg18.container.stop();
});

const backfilled = () =>
  asAdmin<{ id: string; org_id: string; payload: unknown; user_id: string }>(
    `SELECT id::text, org_id::text, payload, payload->>'userId' AS user_id
     FROM bricx.outbox WHERE topic = 'users.mfa_check' ORDER BY payload->>'userId'`,
  );

describe("0012 backfill (C3)", () => {
  test("0012 is applied", async () => {
    const [last] = await asAdmin<{ tag: string }>(
      "SELECT tag FROM bricx_migrations.applied ORDER BY idx DESC LIMIT 1",
    );
    expect(last?.tag).toBe(TAG);
  });

  test("bounded: exactly the users v3 covers and v2 did not, one row each, payload { userId } only, the user's org, a UUIDv7 id", async () => {
    const rows = await backfilled();
    expect(rows.map((r) => r.user_id).sort()).toEqual(
      [users.adminRole, users.adminOverride, users.adminGrant].sort(),
    );
    for (const row of rows) {
      expect(row.payload).toEqual({ userId: row.user_id });
      expect(row.org_id).toBe(ORG);
      expect(row.id).toMatch(UUID_V7);
    }
  });

  test("idempotent: the backfill block run again selects the same users and adds no row; its ids are stable", async () => {
    const first = await backfilled();
    // The selection is state-independent: the same three users again.
    const [selected] = await asAdmin<{ n: number }>(
      `SELECT count(*)::int AS n FROM bricx.users u
       WHERE app.mfa_admin_held(u.id) AND NOT app.mfa_finance_held(u.id)`,
    );
    expect(selected?.n).toBe(3);
    const client = new pg.Client({ connectionString: urlFor("bricx_owner") });
    await client.connect();
    try {
      await client.query("BEGIN");
      for (const statement of await backfillStatements()) {
        await client.query(statement);
      }
      await client.query("COMMIT");
    } finally {
      await client.end();
    }
    expect(await backfilled()).toEqual(first);
  });

  test("no policy is left behind and FORCE RLS still holds on the outbox", async () => {
    expect(
      await asAdmin(
        `SELECT policyname, cmd, roles::text, qual, with_check FROM pg_policies
         WHERE schemaname = 'bricx' AND tablename = 'outbox' ORDER BY policyname`,
      ),
    ).toEqual(policiesBefore);
    expect(
      await asAdmin(
        `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
         FROM pg_class WHERE oid = 'bricx.outbox'::regclass`,
      ),
    ).toEqual([{ enabled: true, forced: true }]);
    // bricx_owner still cannot write the outbox outside the migration.
    const client = new pg.Client({ connectionString: urlFor("bricx_owner") });
    await client.connect();
    try {
      await expect(
        client.query(
          `INSERT INTO bricx.outbox (org_id, topic, payload)
           VALUES ($1, 'users.mfa_check', '{}'::jsonb)`,
          [ORG],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.end();
    }
  });
});

describe("app.mfa_state(uuid) v3 (C2)", () => {
  test.each([
    ["owner (system role)", "owner", true],
    ["finance key", "finance", true],
    ["custom role with an admin key", "adminRole", true],
    ["project override adding an admin key", "adminOverride", true],
    ["open admin elevation", "adminGrant", true],
    ["admin and finance keys", "adminAndFinance", true],
    ["removed admin membership", "removed", false],
    ["expired admin elevation", "expiredGrant", false],
    ["plain member", "plain", false],
  ] as const)("%s: required %s", async (_what, who, required) => {
    expect(
      await asAdmin(
        "SELECT keycloak_sub, required FROM app.mfa_state($1::uuid)",
        [users[who]],
      ),
    ).toEqual([{ keycloak_sub: `sub-${who}`, required }]);
  });

  test("app.mfa_admin_keys() is exactly @bricx/permissions' MFA_ADMIN_KEYS", async () => {
    const [row] = await asAdmin<{ keys: string[] }>(
      "SELECT app.mfa_admin_keys() AS keys",
    );
    expect([...(row?.keys ?? [])].sort()).toEqual([...MFA_ADMIN_KEYS].sort());
  });

  test("the helper functions: owned by bricx_owner, search_path pinned, not SECURITY DEFINER, EXECUTE for nobody but their owner", async () => {
    const rows = await asAdmin<Record<string, unknown>>(`
      SELECT p.oid::regprocedure::text AS sig, p.prosecdef AS definer,
             p.proowner::regrole::text AS owner, p.proconfig AS config,
             ARRAY(SELECT r.rolname FROM pg_roles r
                   WHERE r.rolname IN ('bricx_app', 'bricx_relay', 'bricx_readonly', 'powersync_repl')
                     AND has_function_privilege(r.rolname, p.oid, 'EXECUTE')
                   ORDER BY r.rolname) AS executors
      FROM pg_proc p
      WHERE p.oid IN ('app.mfa_admin_keys()'::regprocedure,
                      'app.mfa_admin_held(uuid)'::regprocedure,
                      'app.mfa_finance_held(uuid)'::regprocedure)
      ORDER BY 1`);
    expect(rows).toEqual([
      {
        sig: "app.mfa_admin_held(uuid)",
        definer: false,
        owner: "bricx_owner",
        config: ["search_path=pg_catalog, pg_temp"],
        executors: [],
      },
      {
        sig: "app.mfa_admin_keys()",
        definer: false,
        owner: "bricx_owner",
        config: ["search_path=pg_catalog, pg_temp"],
        executors: [],
      },
      {
        sig: "app.mfa_finance_held(uuid)",
        definer: false,
        owner: "bricx_owner",
        config: ["search_path=pg_catalog, pg_temp"],
        executors: [],
      },
      {
        sig: "app.mfa_admin_keys()",
        definer: false,
        owner: "bricx_owner",
        config: ["search_path=pg_catalog, pg_temp"],
        executors: [],
      },
    ]);
  });
});
