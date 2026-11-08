// P6-05 (ADR 0075 D11; the P6-03 Also line, owner conditions C1, C9):
// migration 0011 fails loudly on rows the new constraints refuse. No
// NOT VALID, no DELETE, no skip: an orphan project id in region_configs,
// project_memberships or access_grants, a region_configs project row
// holding a currency, reporting currency or timezone, or an elevation
// whose scope does not fit its key stops the migration with the
// constraint's SQLSTATE; nothing of 0011 is applied, every row stays, and
// the history still ends at 0010. The orphans belong to an organisation
// and the migrator runs as bricx_owner with no context: under FORCE RLS
// the owner's foreign-key validation query would see none of them, so
// 0011 lifts FORCE around each validation (sabotage: without that step
// every 23503 scenario here applies 0011 instead).
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
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MIGRATIONS_DIR, MigrationError, migrate } from "../src/migrate.js";

const NOW = "2026-11-08T12:00:00.000Z";
const LATER = "2026-11-08T13:00:00.000Z";
const TAG = "0011_projects_sites";

let pg18: BootstrappedPostgres;
let n = 0;
const nextId = (): string => {
  n += 1;
  return `0199e1d6-${n.toString(16).padStart(4, "0")}-7000-8000-${randomUUID().slice(-12)}`;
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

/** The production migrations up to and including 0010, in a temp folder. */
async function migrationsThrough0010(): Promise<string> {
  const journal = JSON.parse(
    await readFile(path.join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string }[] };
  const entries = journal.entries.filter((e) => e.idx <= 10);
  expect(entries.map((e) => e.idx)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const dir = await mkdtemp(path.join(os.tmpdir(), "bricx-0010-"));
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

const lastApplied = async () =>
  (
    await asAdmin<{ tag: string }>(
      "SELECT tag FROM bricx_migrations.applied ORDER BY idx DESC LIMIT 1",
    )
  )[0]?.tag;

let org: string;
let user: string;
let by: string;
let role: string;

beforeAll(async () => {
  pg18 = await startPostgres();
  await migrate(urlFor("bricx_owner"), await migrationsThrough0010());
  expect(await lastApplied()).toBe("0010_region_configs");
  org = nextId();
  user = nextId();
  by = nextId();
  role = nextId();
  await asAdmin(
    `INSERT INTO bricx.organizations
       (id, slug, legal_name, country, default_currency, default_language,
        timezone, units, data_region, created_at, updated_at)
     VALUES ($1, 'orphans', 'Orphans Ltd', 'SL', 'SLE', 'en', 'Africa/Freetown',
        'metric', 'af-south-1', $2, $2)`,
    [org, NOW],
  );
  await asAdmin(
    `INSERT INTO bricx.users (id, keycloak_sub, created_at, last_seen_at)
     VALUES ($1, 'orphan-user', $3, $3), ($2, 'orphan-granter', $3, $3)`,
    [user, by, NOW],
  );
  await asAdmin(
    `INSERT INTO bricx.roles (id, org_id, key, name, created_at, updated_at)
     VALUES ($1, $2, 'r_orphans', 'Role', $3, $3)`,
    [role, org, NOW],
  );
}, 300_000);
afterAll(async () => {
  await pg18.container.stop();
});

interface Scenario {
  readonly name: string;
  readonly table: string;
  readonly insert: () => { text: string; params: unknown[] };
  readonly sqlState: string;
  readonly constraint: string;
}

const grant = (permission: string, scopeId: string | null) => ({
  text: `INSERT INTO bricx.access_grants
           (id, org_id, user_id, permission, scope_id, reason, granted_by,
            starts_at, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, 'cover', $6, $7, $8, $7)`,
  params: [nextId(), org, user, permission, scopeId, by, NOW, LATER],
});

const scenarios: readonly Scenario[] = [
  {
    name: "a region_configs project row for a project that does not exist",
    table: "region_configs",
    insert: () => ({
      text: `INSERT INTO bricx.region_configs (id, org_id, project_id, language, created_at, updated_at)
             VALUES ($1, $2, $3, 'fr', $4, $4)`,
      params: [nextId(), org, nextId(), NOW],
    }),
    sqlState: "23503",
    constraint: "region_configs_project_fk",
  },
  {
    name: "a region_configs project row holding a currency (C1)",
    table: "region_configs",
    insert: () => ({
      text: `INSERT INTO bricx.region_configs (id, org_id, project_id, currency, created_at, updated_at)
             VALUES ($1, $2, $3, 'USD', $4, $4)`,
      params: [nextId(), org, nextId(), NOW],
    }),
    sqlState: "23514",
    constraint: "region_configs_project_fields",
  },
  {
    name: "a region_configs project row holding a reporting currency (C1)",
    table: "region_configs",
    insert: () => ({
      text: `INSERT INTO bricx.region_configs (id, org_id, project_id, reporting_currency, created_at, updated_at)
             VALUES ($1, $2, $3, 'USD', $4, $4)`,
      params: [nextId(), org, nextId(), NOW],
    }),
    sqlState: "23514",
    constraint: "region_configs_project_fields",
  },
  {
    name: "a region_configs project row holding a timezone (C1)",
    table: "region_configs",
    insert: () => ({
      text: `INSERT INTO bricx.region_configs (id, org_id, project_id, timezone, created_at, updated_at)
             VALUES ($1, $2, $3, 'Africa/Lagos', $4, $4)`,
      params: [nextId(), org, nextId(), NOW],
    }),
    sqlState: "23514",
    constraint: "region_configs_project_fields",
  },
  {
    name: "a project membership of a project that does not exist",
    table: "project_memberships",
    insert: () => ({
      text: `INSERT INTO bricx.project_memberships (id, org_id, project_id, user_id, role_id, created_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
      params: [nextId(), org, nextId(), user, role, NOW],
    }),
    sqlState: "23503",
    constraint: "project_memberships_project_fk",
  },
  {
    name: "an elevation scoped to a project that does not exist",
    table: "access_grants",
    insert: () => grant("project.project.update.project", nextId()),
    sqlState: "23503",
    constraint: "access_grants_project_fk",
  },
  {
    name: "an org key elevation with a scope (C9)",
    table: "access_grants",
    insert: () => grant("org.member.read.org", nextId()),
    sqlState: "23514",
    constraint: "access_grants_scope",
  },
];

describe("migration 0011 fails loudly on existing rows it would refuse (D11, C1, C9)", () => {
  test.each(scenarios)(
    "$name: $sqlState on $constraint, nothing applied, the row stays",
    async ({ table, insert, sqlState, constraint }) => {
      const q = insert();
      await asAdmin(q.text, q.params);
      const id = q.params[0];
      const before = await asAdmin<{ n: number }>(
        `SELECT count(*)::int AS n FROM bricx.${table}`,
      );
      const failure = await migrate(urlFor("bricx_owner")).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(MigrationError);
      expect(failure).toMatchObject({
        code: "migration_failed",
        tag: TAG,
        sqlState,
      });
      expect((failure as MigrationError).serverMessage).toContain(constraint);
      // Nothing of 0011 is applied: its tables do not exist, the history
      // ends at 0010, and the refused row is untouched.
      expect(await lastApplied()).toBe("0010_region_configs");
      expect(
        await asAdmin("SELECT to_regclass('bricx.projects')::text AS t"),
      ).toEqual([{ t: null }]);
      expect(
        await asAdmin(`SELECT count(*)::int AS n FROM bricx.${table}`),
      ).toEqual(before);
      expect(
        await asAdmin(
          `SELECT count(*)::int AS n FROM bricx.${table} WHERE id = $1`,
          [id],
        ),
      ).toEqual([{ n: 1 }]);
      // The operator's fix, outside the migration: remove the row by hand.
      await asAdmin(`DELETE FROM bricx.${table} WHERE id = $1`, [id]);
    },
  );

  test("with no such row left, 0011 applies; existing well-formed rows stay", async () => {
    await asAdmin(
      `INSERT INTO bricx.region_configs (id, org_id, project_id, reporting_currency, created_at, updated_at)
       VALUES ($1, $2, NULL, 'USD', $3, $3)`,
      [nextId(), org, NOW],
    );
    const kept = grant("org.member.read.org", null);
    await asAdmin(kept.text, kept.params);
    const result = await migrate(urlFor("bricx_owner"));
    expect(result.applied[0]).toBe(TAG);
    expect(
      await asAdmin("SELECT count(*)::int AS n FROM bricx.region_configs"),
    ).toEqual([{ n: 1 }]);
    expect(
      await asAdmin("SELECT count(*)::int AS n FROM bricx.access_grants"),
    ).toEqual([{ n: 1 }]);
  });
});
