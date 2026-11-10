// P6-06 (ADR 0077): migration 0013 against a real Postgres 18.
// - G1 viewer backfill: from a database at 0012, every organisation with
//   system roles and no viewer gets ONE viewer role ('viewer', or
//   'system_viewer' where a custom role already holds the key 'viewer')
//   with exactly @bricx/permissions VIEWER_KEYS (app.viewer_keys() is
//   their SQL copy); an organisation without system roles gets none; the
//   two backfill policies are gone after COMMIT; a second migrate is a
//   no-op.
// - bricx.invitations is FORCE RLS: bricx_app sees and writes its own
//   org's rows only; bricx_app has column UPDATE on the mutable columns
//   only; there is no DELETE policy, so its DELETE matches no row.
// - C6 guard (SQLSTATE P6006), both ways: the accept may null
//   email_normalised (pending -> accepted, same UPDATE); nothing else may
//   change the address, the identity columns, or a settled row.
// - one pending invitation per (org, project, address): of two concurrent
//   inserts one commits and the other is 23505 (the index, not a read).
// - region_configs.invitation_ttl_hours (D10): the org row only, 1..168;
//   NULL on every row, a project row included.
// - the definer functions: app.invitation_by_token_hash() is bricx_app's
//   only, answers id, org and inviter for a 32-byte hash and nothing for
//   any other input; app.invitations_due() is bricx_relay's only.
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
import { VIEWER_KEYS } from "@bricx/permissions/roles";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Database, openDatabase } from "../src/database.js";
import { MIGRATIONS_DIR, migrate } from "../src/migrate.js";

const NOW = "2026-11-10T12:00:00.000Z";

let pg18: BootstrappedPostgres;
let app: Database;
let n = 0;
const nextId = (): string => {
  n += 1;
  return `0199e1d7-${n.toString(16).padStart(4, "0")}-7000-8000-${randomUUID().slice(-12)}`;
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

/** The production migrations up to and including 0012, in a temp folder. */
async function migrationsThrough0012(): Promise<string> {
  const journal = JSON.parse(
    await readFile(path.join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string }[] };
  const entries = journal.entries.filter((e) => e.idx <= 12);
  expect(entries.at(-1)?.idx).toBe(12);
  const dir = await mkdtemp(path.join(os.tmpdir(), "bricx-0012-"));
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

const orgs = { plain: "", custom: "", bare: "", other: "" };
let inviter: string;
let invitee: string;
let roleA: string;
let roleOther: string;

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
  org: string,
  key: string,
  systemKey: string | null,
): Promise<string> {
  const id = nextId();
  await asAdmin(
    `INSERT INTO bricx.roles (id, org_id, key, name, system_key, created_at, updated_at)
     VALUES ($1, $2, $3, $3, $4, $5, $5)`,
    [id, org, key, systemKey, NOW],
  );
  return id;
}

beforeAll(async () => {
  pg18 = await startPostgres();
  await migrate(urlFor("bricx_owner"), await migrationsThrough0012());
  orgs.plain = nextId();
  orgs.custom = nextId();
  orgs.bare = nextId();
  orgs.other = nextId();
  await seedOrg(orgs.plain, "plain");
  await seedOrg(orgs.custom, "custom");
  await seedOrg(orgs.bare, "bare");
  await seedOrg(orgs.other, "other");
  roleA = await seedRole(orgs.plain, "owner", "owner");
  await seedRole(orgs.custom, "owner", "owner");
  // A custom role already named viewer: the backfill takes system_viewer.
  await seedRole(orgs.custom, "viewer", null);
  // bare: a custom role only, no system roles: no backfill.
  await seedRole(orgs.bare, "crew", null);
  roleOther = await seedRole(orgs.other, "owner", "owner");
  inviter = nextId();
  invitee = nextId();
  await asAdmin(
    `INSERT INTO bricx.users (id, keycloak_sub, created_at, last_seen_at)
     VALUES ($1, 'm13-inviter', $3, $3), ($2, 'm13-invitee', $3, $3)`,
    [inviter, invitee, NOW],
  );
  await migrate(urlFor("bricx_owner"));
  app = openDatabase(urlFor("bricx_app"));
}, 300_000);
afterAll(async () => {
  await app.close().catch(() => undefined);
  await pg18.container.stop();
});

const viewerRoles = (org: string) =>
  asAdmin<{ id: string; key: string }>(
    "SELECT id::text, key FROM bricx.roles WHERE org_id = $1 AND system_key = 'viewer' AND archived_at IS NULL",
    [org],
  );
const keysOf = async (role: string) =>
  (
    await asAdmin<{ permission: string }>(
      "SELECT permission FROM bricx.role_permissions WHERE role_id = $1 ORDER BY permission",
      [role],
    )
  ).map((r) => r.permission);

describe("G1: the viewer backfill", () => {
  test("one viewer role with exactly VIEWER_KEYS per organisation with system roles; system_viewer beside a custom 'viewer'; none without system roles", async () => {
    const plain = await viewerRoles(orgs.plain);
    expect(plain.map((r) => r.key)).toEqual(["viewer"]);
    expect(await keysOf(plain[0]?.id ?? "")).toEqual([...VIEWER_KEYS].sort());
    const custom = await viewerRoles(orgs.custom);
    expect(custom.map((r) => r.key)).toEqual(["system_viewer"]);
    expect(await keysOf(custom[0]?.id ?? "")).toEqual([...VIEWER_KEYS].sort());
    expect(await viewerRoles(orgs.bare)).toEqual([]);
  });

  test("app.viewer_keys() is VIEWER_KEYS; the backfill policies are gone; a second migrate changes nothing", async () => {
    const [row] = await asAdmin<{ keys: string[] }>(
      "SELECT app.viewer_keys() AS keys",
    );
    expect([...(row?.keys ?? [])].sort()).toEqual([...VIEWER_KEYS].sort());
    expect(
      await asAdmin(
        "SELECT policyname FROM pg_policies WHERE policyname LIKE '%viewer_backfill%'",
      ),
    ).toEqual([]);
    const before = await asAdmin<{ n: number }>(
      "SELECT count(*)::int AS n FROM bricx.roles WHERE system_key = 'viewer'",
    );
    await migrate(urlFor("bricx_owner"));
    expect(
      await asAdmin<{ n: number }>(
        "SELECT count(*)::int AS n FROM bricx.roles WHERE system_key = 'viewer'",
      ),
    ).toEqual(before);
  });
});

async function insertInvitation(
  org: string,
  role: string,
  email: string,
  extra: { tokenHash?: Buffer } = {},
): Promise<string> {
  const id = nextId();
  await asAdmin(
    `INSERT INTO bricx.invitations
       (id, org_id, email_normalised, role_id, token_hash, expires_at,
        invited_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz + interval '72 hours', $7, $6, $6)`,
    [id, org, email, role, extra.tokenHash ?? null, NOW, inviter],
  );
  return id;
}

async function sqlStateOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    // withTx() wraps the driver's error; the SQLSTATE is on a cause.
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

describe("bricx.invitations: FORCE RLS and the app's grants", () => {
  test("FORCE RLS; bricx_app sees its org's rows only, cannot write another org's; no DELETE policy, so a DELETE matches no row (the rls.ts convention)", async () => {
    const [cls] = await asAdmin<{ force: boolean; enabled: boolean }>(
      "SELECT relforcerowsecurity AS force, relrowsecurity AS enabled FROM pg_class WHERE oid = 'bricx.invitations'::regclass",
    );
    expect(cls).toEqual({ force: true, enabled: true });
    const mine = await insertInvitation(
      orgs.plain,
      roleA,
      "rls-a@site.example",
    );
    await insertInvitation(orgs.other, roleOther, "rls-b@site.example");
    const seen = await app.withTx(
      { orgId: orgs.plain, userId: inviter, projectIds: [] },
      async (tx) =>
        (
          await tx.execute<{ id: string }>(
            sql`SELECT id::text FROM bricx.invitations`,
          )
        ).rows.map((r) => r.id),
    );
    expect(seen).toEqual([mine]);
    expect(
      await sqlStateOf(() =>
        app.withTx(
          { orgId: orgs.plain, userId: inviter, projectIds: [] },
          (tx) =>
            tx.execute(
              sql`INSERT INTO bricx.invitations (id, org_id, email_normalised, role_id, expires_at, invited_by, created_at, updated_at)
                  VALUES (${nextId()}::uuid, ${orgs.other}::uuid, 'x-org@site.example', ${roleOther}::uuid, now() + interval '1 hour', ${inviter}::uuid, now(), now())`,
            ),
        ),
      ),
    ).toBe("42501");
    const privileges = await asAdmin<{ privilege_type: string }>(
      "SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'bricx' AND table_name = 'invitations' AND grantee = 'bricx_app' ORDER BY 1",
    );
    expect(privileges.map((p) => p.privilege_type)).toEqual([
      "DELETE",
      "INSERT",
      "SELECT",
    ]);
    expect(
      await asAdmin(
        "SELECT policyname FROM pg_policies WHERE schemaname = 'bricx' AND tablename = 'invitations' AND cmd IN ('DELETE', 'ALL')",
      ),
    ).toEqual([]);
    const deleted = await app.withTx(
      { orgId: orgs.plain, userId: inviter, projectIds: [] },
      async (tx) =>
        (
          await tx.execute(
            sql`DELETE FROM bricx.invitations WHERE id = ${mine}::uuid RETURNING id`,
          )
        ).rows.length,
    );
    expect(deleted).toBe(0);
    expect(
      await asAdmin("SELECT 1 FROM bricx.invitations WHERE id = $1", [mine]),
    ).toHaveLength(1);
    const columns = await asAdmin<{ column_name: string }>(
      "SELECT column_name FROM information_schema.column_privileges WHERE table_schema = 'bricx' AND table_name = 'invitations' AND grantee = 'bricx_app' AND privilege_type = 'UPDATE' ORDER BY 1",
    );
    expect(columns.map((c) => c.column_name)).toEqual(
      [
        "accepted_at",
        "accepted_by",
        "activation_count",
        "email_normalised",
        "expires_at",
        "last_sent_at",
        "resend_count",
        "revoke_reason",
        "revoked_at",
        "revoked_by",
        "send_seq",
        "status",
        "token_hash",
        "updated_at",
      ].sort(),
    );
  });
});

describe("C6: the guard trigger (P6006)", () => {
  test("the accept nulls email_normalised (pending -> accepted in one UPDATE): allowed", async () => {
    const id = await insertInvitation(orgs.plain, roleA, "c6-ok@site.example");
    await asAdmin(
      `UPDATE bricx.invitations SET status = 'accepted', email_normalised = NULL,
         accepted_by = $2, accepted_at = $3::timestamptz + interval '1 minute',
         token_hash = NULL, updated_at = $3::timestamptz + interval '1 minute'
       WHERE id = $1`,
      [id, invitee, NOW],
    );
    expect(
      await asAdmin(
        "SELECT status, email_normalised FROM bricx.invitations WHERE id = $1",
        [id],
      ),
    ).toEqual([{ status: "accepted", email_normalised: null }]);
  });

  test("refused: the address nulled while pending, the address changed, an identity column changed, any change to a settled row", async () => {
    const id = await insertInvitation(orgs.plain, roleA, "c6-no@site.example");
    for (const change of [
      "email_normalised = NULL",
      "email_normalised = 'c6-other@site.example'",
      `role_id = '${roleA}'::uuid, invited_by = '${invitee}'::uuid`,
      `org_id = '${orgs.other}'::uuid`,
      "created_at = created_at - interval '1 minute'",
    ]) {
      expect(
        await sqlStateOf(() =>
          asAdmin(`UPDATE bricx.invitations SET ${change} WHERE id = $1`, [id]),
        ),
        change,
      ).toBe("P6006");
    }
    // The address nulled with the status moving elsewhere than accepted.
    expect(
      await sqlStateOf(() =>
        asAdmin(
          `UPDATE bricx.invitations SET status = 'revoked', email_normalised = NULL,
             revoked_at = now(), revoke_reason = 'manual' WHERE id = $1`,
          [id],
        ),
      ),
    ).toBe("P6006");
    await asAdmin(
      `UPDATE bricx.invitations SET status = 'revoked', revoked_at = $2::timestamptz + interval '1 minute',
         revoke_reason = 'manual' WHERE id = $1`,
      [id, NOW],
    );
    for (const change of [
      "status = 'pending', revoked_at = NULL, revoke_reason = NULL",
      "updated_at = updated_at + interval '1 minute'",
      "token_hash = NULL",
    ]) {
      expect(
        await sqlStateOf(() =>
          asAdmin(`UPDATE bricx.invitations SET ${change} WHERE id = $1`, [id]),
        ),
        change,
      ).toBe("P6006");
    }
  });
});

describe("one pending invitation per (org, project, address)", () => {
  test("two concurrent inserts: one commits, the other is 23505 on invitations_pending_email", async () => {
    const [a, b] = [await pg18.admin(), await pg18.admin()];
    try {
      const insert = (client: pg.Client) =>
        client.query(
          `INSERT INTO bricx.invitations
             (id, org_id, email_normalised, role_id, expires_at, invited_by, created_at, updated_at)
           VALUES ($1, $2, 'race@site.example', $3, $4::timestamptz + interval '1 hour', $5, $4, $4)`,
          [nextId(), orgs.plain, roleA, NOW, inviter],
        );
      await a.query("BEGIN");
      await b.query("BEGIN");
      await insert(a);
      const second = insert(b).then(
        () => "inserted",
        (error: unknown) =>
          `${String((error as { code?: unknown }).code)}:${String((error as { constraint?: unknown }).constraint)}`,
      );
      await a.query("COMMIT");
      expect(await second).toBe("23505:invitations_pending_email");
      await b.query("ROLLBACK");
    } finally {
      await a.end();
      await b.end();
    }
    expect(
      await asAdmin(
        "SELECT 1 FROM bricx.invitations WHERE email_normalised = 'race@site.example'",
      ),
    ).toHaveLength(1);
  });
});

describe("the definer functions", () => {
  test("app.invitation_by_token_hash(): bricx_app only; id, org and inviter for a 32-byte hash; nothing for any other input", async () => {
    const hash = Buffer.alloc(32, 9);
    const id = await insertInvitation(
      orgs.other,
      roleOther,
      "hash@site.example",
      { tokenHash: hash },
    );
    // From another org's context: the lookup is cross-org by design.
    const found = await app.withTx(
      { orgId: orgs.plain, userId: inviter, projectIds: [] },
      async (tx) =>
        (
          await tx.execute(
            sql`SELECT id::text, org_id::text, invited_by::text FROM app.invitation_by_token_hash(${hash})`,
          )
        ).rows,
    );
    expect(found).toEqual([{ id, org_id: orgs.other, invited_by: inviter }]);
    for (const other of [
      Buffer.alloc(31, 9),
      Buffer.alloc(33, 9),
      Buffer.alloc(32, 8),
    ]) {
      const none = await app.withTx(
        { orgId: orgs.plain, userId: inviter, projectIds: [] },
        async (tx) =>
          (
            await tx.execute(
              sql`SELECT * FROM app.invitation_by_token_hash(${other})`,
            )
          ).rows,
      );
      expect(none).toEqual([]);
    }
    const acl = await asAdmin<{ role: string; fn: string }>(
      `SELECT r.rolname AS role, p.proname AS fn
       FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace,
            pg_roles r
       WHERE ns.nspname = 'app' AND p.proname IN ('invitation_by_token_hash', 'invitations_due')
         AND r.rolname IN ('bricx_app', 'bricx_relay', 'bricx_readonly')
         AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
       ORDER BY 1, 2`,
    );
    expect(acl).toEqual([
      { role: "bricx_app", fn: "invitation_by_token_hash" },
      { role: "bricx_relay", fn: "invitations_due" },
    ]);
    const [publicAcl] = await asAdmin<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_proc p
       WHERE p.proname IN ('invitation_by_token_hash', 'invitations_due', 'viewer_keys')
         AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0))`,
    );
    expect(publicAcl?.n).toBe(0);
  });
});

describe("region_configs.invitation_ttl_hours (D10)", () => {
  test("NULL on an org row and on a project row; 1..168 on the org row only (23514 otherwise)", async () => {
    const project = "0199e1d7-ffff-7000-8000-000000000001";
    await seedProject(asAdmin, orgs.other, project);
    const insert = (projectId: string | null, ttl: number | null) =>
      sqlStateOf(() =>
        asAdmin(
          `INSERT INTO bricx.region_configs (id, org_id, project_id, invitation_ttl_hours, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $5)`,
          [nextId(), orgs.other, projectId, ttl, NOW],
        ),
      );
    expect(await insert(project, null)).toBe("none");
    expect(await insert(project, 72)).toBe("23514");
    for (const ttl of [0, 169]) expect(await insert(null, ttl)).toBe("23514");
    expect(await insert(null, 168)).toBe("none");
    await asAdmin(
      "DELETE FROM bricx.region_configs WHERE org_id = $1 AND project_id IS NULL",
      [orgs.other],
    );
    expect(await insert(null, null)).toBe("none");
  });
});
