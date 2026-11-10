// P6-02 (ADR 0072; owner rulings R4, R6 and conditions C2, C4): migration
// 0009 and @bricx/db/organizations against compose.yml's Postgres with the
// production journal, applied by the real migrator as bricx_owner.
// - bricx.organizations (org.organization, tenant column id): FORCE RLS,
//   one organisation never sees or writes another's row; bricx_app may
//   UPDATE only the editable columns; id, slug, data_region and created_at
//   never change for any role (trigger, P6002); archived_at is set once,
//   and only bricx_owner clears it (the restore runbook, D16); nobody
//   deletes a row.
// - roles.org_id and memberships.org_id reference organizations (the P5-05
//   Also line): a role or membership for a missing organisation is 23503.
// - bricx.org_create_attempts (a user table): own rows only, in any org;
//   bricx_app may UPDATE state and settled_at only, once, from pending to
//   committed or refused (trigger, P6003); nobody deletes; not synced.
// - createOrganization() writes the row, its thirteen roles (twelve before P6-06), the first owner,
//   one users.mfa_check outbox row and two audit events (org.member.bootstrap
//   then org.organization.create, actor the owner) in the caller's
//   transaction; a failure leaves nothing. bootstrapOrganization() refuses
//   a missing organisation (org_missing), a non-empty one (org_not_empty)
//   and an unknown user (user_missing).
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  type BootstrappedPostgres,
  type Role,
  appDatabase,
  exampleValue,
  rolePasswordKeys,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { ROLE_IDS, ROLES } from "@bricx/permissions/roles";
import { PgDialect } from "drizzle-orm/pg-core";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Database, openDatabase, sqlstateOf } from "../src/database.js";
import { migrate } from "../src/migrate.js";
import {
  BootstrapError,
  type NewOrganization,
  bootstrapOrganization,
  createOrganization,
  readOrganization,
} from "../src/organizations.js";
import {
  ORGANIZATION_APP_COLUMNS,
  ORG_CREATE_ATTEMPT_APP_COLUMNS,
  TENANT_TABLES,
  TENANT_UPDATE_COLUMNS,
  USER_TABLES,
} from "../src/rls.js";
import {
  type TxContext,
  contextStatement,
  validateTxContext,
} from "../src/tx.js";

const DENIED = "42501";
const FK = "23503";
const CHECK = "23514";
const IMMUTABLE = "P6002";
const SETTLE_ONCE = "P6003";
const dialect = new PgDialect();

let pg18: BootstrappedPostgres;
let app: Database;
let n = 0;
/** A UUIDv7-shaped id (version 7, variant 10), unique per call. */
const nextId = (): string => {
  n += 1;
  return `0199e1c0-${n.toString(16).padStart(4, "0")}-7000-8000-${randomUUID().slice(-12)}`;
};
const clock = { now: () => Date.UTC(2026, 10, 6, 12, 0, 0) };
const ids = { next: nextId };
const deps = () => ({ clock, ids, origin: { correlationId: nextId() } });
const NOW = "2026-11-06T12:00:00.000Z";

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

/** "ok:<rowCount>" or the SQLSTATE, as the test superuser, rolled back. */
async function adminOutcome(text: string, params: unknown[] = []) {
  const admin = await pg18.admin();
  try {
    await admin.query("BEGIN");
    try {
      const r = await admin.query(text, params);
      return `ok:${String(r.rowCount)}`;
    } catch (error) {
      return sqlstateOf(error) ?? "?";
    } finally {
      await admin.query("ROLLBACK");
    }
  } finally {
    await admin.end();
  }
}

/** "ok:<rowCount>" or the SQLSTATE of statements as `who`, rolled back. */
async function outcome(
  who: Role,
  ctx: TxContext | undefined,
  text: string,
  params: unknown[] = [],
): Promise<string> {
  const client = await pg18.connectAs(who);
  try {
    await client.query("BEGIN");
    try {
      if (ctx !== undefined) {
        const q = dialect.sqlToQuery(
          contextStatement(validateTxContext(ctx), 30_000),
        );
        await client.query(q.sql, q.params);
      }
      const r = await client.query(text, params);
      return `ok:${String(r.rowCount)}`;
    } catch (error) {
      return sqlstateOf(error) ?? "?";
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    await client.end();
  }
}

/** A users row for a fresh id (as the test superuser). */
async function seedUser(): Promise<string> {
  const id = nextId();
  await asAdmin(
    `INSERT INTO bricx.users (id, keycloak_sub, created_at, last_seen_at)
     VALUES ($1, $2, now(), now())`,
    [id, `org-test-${id}`],
  );
  return id;
}

const slugOf = (id: string) => `org-${id.slice(-12)}`;

function newOrganization(id: string, ownerId: string): NewOrganization {
  return {
    id,
    slug: slugOf(id),
    legalName: "Acme Builders Ltd",
    country: "SL",
    defaultCurrency: "SLE",
    defaultLanguage: "en",
    timezone: "Africa/Freetown",
    units: "metric",
    dataRegion: "af-south-1",
    brandColor: "#0a7cff",
    ownerId,
    now: NOW,
  };
}

/** An organisation row for `id`, inserted as the test superuser. */
async function seedOrg(id: string, slug = slugOf(id)): Promise<void> {
  await asAdmin(
    `INSERT INTO bricx.organizations
       (id, slug, legal_name, country, default_currency, default_language,
        timezone, units, data_region, created_at, updated_at)
     VALUES ($1, $2, 'Seeded Ltd', 'KE', 'KES', 'en', 'Africa/Nairobi',
        'metric', 'af-south-1', $3, $3)`,
    [id, slug, NOW],
  );
}

const ctx = (orgId: string, userId: string): TxContext => ({
  orgId,
  userId,
  projectIds: [],
});

beforeAll(async () => {
  pg18 = await startPostgres();
  await migrate(urlFor("bricx_owner"));
  app = openDatabase(urlFor("bricx_app"));
}, 300_000);
afterAll(async () => {
  await app.close();
  await pg18.container.stop();
});

describe("migration 0009: bricx.organizations", () => {
  test("registered: a tenant table of org.organization (tenant column id) with column-limited UPDATE; the attempts a user table", () => {
    expect(TENANT_TABLES["bricx.organizations"]).toBe("org.organization");
    expect(TENANT_UPDATE_COLUMNS["bricx.organizations"]).toEqual(
      ORGANIZATION_APP_COLUMNS,
    );
    expect([...ORGANIZATION_APP_COLUMNS].sort()).toEqual(
      [
        "archived_at",
        "brand_color",
        "country",
        "default_currency",
        "default_language",
        "legal_name",
        "logo_object_key",
        "timezone",
        "units",
        "updated_at",
      ].sort(),
    );
    expect(USER_TABLES["bricx.org_create_attempts"]).toBe(
      "org_create_attempts",
    );
    expect([...ORG_CREATE_ATTEMPT_APP_COLUMNS]).toEqual([
      "state",
      "settled_at",
    ]);
  });

  test("ENABLE + FORCE row level security on both tables; neither is published to PowerSync", async () => {
    expect(
      await asAdmin(
        `SELECT relname AS t, relrowsecurity AS enabled, relforcerowsecurity AS forced
         FROM pg_class WHERE oid IN ('bricx.organizations'::regclass, 'bricx.org_create_attempts'::regclass)
         ORDER BY relname`,
      ),
    ).toEqual([
      { t: "org_create_attempts", enabled: true, forced: true },
      { t: "organizations", enabled: true, forced: true },
    ]);
    expect(
      await asAdmin(
        `SELECT tablename FROM pg_publication_tables
         WHERE schemaname = 'bricx' AND tablename IN ('organizations', 'org_create_attempts')`,
      ),
    ).toEqual([]);
  });

  test("RLS: an organisation sees and writes only its own row", async () => {
    const a = nextId();
    const b = nextId();
    const user = await seedUser();
    await seedOrg(a);
    await seedOrg(b);
    expect(
      await outcome(
        "bricx_app",
        ctx(a, user),
        "SELECT id FROM bricx.organizations WHERE id IN ($1, $2)",
        [a, b],
      ),
    ).toBe("ok:1");
    expect(
      await outcome(
        "bricx_app",
        ctx(a, user),
        "UPDATE bricx.organizations SET legal_name = 'X' WHERE id = $1",
        [b],
      ),
    ).toBe("ok:0");
    // Inserting another organisation's id from org a's context.
    const c = nextId();
    expect(
      await outcome(
        "bricx_app",
        ctx(a, user),
        `INSERT INTO bricx.organizations (id, slug, legal_name, country, default_currency,
           default_language, timezone, units, data_region, created_at, updated_at)
         VALUES ($1, $2, 'C', 'SL', 'USD', 'en', 'UTC', 'metric', 'af-south-1', now(), now())`,
        [c, slugOf(c)],
      ),
    ).toBe(DENIED);
    expect(
      await outcome(
        "bricx_app",
        undefined,
        "SELECT id FROM bricx.organizations WHERE id = $1",
        [a],
      ),
    ).toBe("ok:0");
  });

  test("no role deletes an organisation (no DELETE policy under FORCE)", async () => {
    const a = nextId();
    const user = await seedUser();
    await seedOrg(a);
    for (const who of ["bricx_app", "bricx_owner"] as const) {
      const result = await outcome(
        who,
        ctx(a, user),
        "DELETE FROM bricx.organizations WHERE id = $1",
        [a],
      );
      expect([who, result === "ok:0" || result === DENIED]).toEqual([
        who,
        true,
      ]);
    }
    expect(
      await asAdmin("SELECT id FROM bricx.organizations WHERE id = $1", [a]),
    ).toEqual([{ id: a }]);
  });

  test("bricx_app may UPDATE only the editable columns: slug, data_region, created_at and id are 42501", async () => {
    const a = nextId();
    const user = await seedUser();
    await seedOrg(a);
    for (const set of [
      "slug = 'other-slug'",
      "data_region = 'eu-west-1'",
      "created_at = now()",
      `id = '${nextId()}'`,
    ]) {
      expect([
        set,
        await outcome(
          "bricx_app",
          ctx(a, user),
          `UPDATE bricx.organizations SET ${set} WHERE id = $1`,
          [a],
        ),
      ]).toEqual([set, DENIED]);
    }
    expect(
      await outcome(
        "bricx_app",
        ctx(a, user),
        "UPDATE bricx.organizations SET legal_name = 'Renamed Ltd', updated_at = now() WHERE id = $1",
        [a],
      ),
    ).toBe("ok:1");
  });

  test("id, slug, data_region and created_at never change, for the owner and the superuser too (P6002)", async () => {
    const a = nextId();
    const user = await seedUser();
    await seedOrg(a);
    for (const set of [
      "slug = 'other-slug'",
      "data_region = 'eu-west-1'",
      "created_at = created_at - interval '1 day'",
      `id = '${nextId()}'`,
    ]) {
      expect([
        set,
        await outcome(
          "bricx_owner",
          ctx(a, user),
          `UPDATE bricx.organizations SET ${set} WHERE id = $1`,
          [a],
        ),
      ]).toEqual([set, IMMUTABLE]);
      expect([
        set,
        await adminOutcome(
          `UPDATE bricx.organizations SET ${set} WHERE id = $1`,
          [a],
        ),
      ]).toEqual([set, IMMUTABLE]);
    }
    // A no-op write of the same values passes.
    expect(
      await adminOutcome(
        "UPDATE bricx.organizations SET slug = slug, data_region = data_region WHERE id = $1",
        [a],
      ),
    ).toBe("ok:1");
  });

  test("archived_at is set once and never cleared or moved", async () => {
    const a = nextId();
    const user = await seedUser();
    await seedOrg(a);
    const client = await pg18.connectAs("bricx_app");
    try {
      await client.query("BEGIN");
      const q = dialect.sqlToQuery(
        contextStatement(validateTxContext(ctx(a, user)), 30_000),
      );
      await client.query(q.sql, q.params);
      const archived = await client.query(
        "UPDATE bricx.organizations SET archived_at = now(), updated_at = now() WHERE id = $1",
        [a],
      );
      expect(archived.rowCount).toBe(1);
      await client.query("COMMIT");
    } finally {
      await client.end();
    }
    for (const set of [
      "archived_at = NULL",
      "archived_at = archived_at + interval '1 second'",
    ]) {
      expect([
        set,
        await outcome(
          "bricx_app",
          ctx(a, user),
          `UPDATE bricx.organizations SET ${set} WHERE id = $1`,
          [a],
        ),
      ]).toEqual([set, IMMUTABLE]);
    }
    expect(
      await outcome(
        "bricx_app",
        ctx(a, user),
        "UPDATE bricx.organizations SET legal_name = 'Still editable' WHERE id = $1",
        [a],
      ),
    ).toBe("ok:1");
  });

  test("the restore runbook (D16): bricx_owner, in the organisation, clears archived_at; bricx_app and the superuser may not; nobody moves it", async () => {
    const a = nextId();
    const user = await seedUser();
    await seedOrg(a);
    await asAdmin(
      "ALTER TABLE bricx.organizations DISABLE TRIGGER organizations_immutable",
    );
    try {
      await asAdmin(
        "UPDATE bricx.organizations SET archived_at = now() WHERE id = $1",
        [a],
      );
    } finally {
      await asAdmin(
        "ALTER TABLE bricx.organizations ENABLE TRIGGER organizations_immutable",
      );
    }
    // docs/runbooks/migrations.md, "Restoring an archived organisation".
    const RESTORE =
      "UPDATE bricx.organizations SET archived_at = NULL, updated_at = now() WHERE id = $1 AND archived_at IS NOT NULL";
    expect(await outcome("bricx_owner", ctx(a, user), RESTORE, [a])).toBe(
      "ok:1",
    );
    expect(await outcome("bricx_app", ctx(a, user), RESTORE, [a])).toBe(
      IMMUTABLE,
    );
    expect(await adminOutcome(RESTORE, [a])).toBe(IMMUTABLE);
    expect(
      await outcome(
        "bricx_owner",
        ctx(a, user),
        "UPDATE bricx.organizations SET archived_at = archived_at + interval '1 second' WHERE id = $1",
        [a],
      ),
    ).toBe(IMMUTABLE);
    // Without the organisation in the context, RLS hides the row.
    expect(await outcome("bricx_owner", undefined, RESTORE, [a])).toBe("ok:0");
  });

  test("the CHECKs hold every shape (slug, codes, units, region, colour, lengths, UUIDv7)", async () => {
    const insert = (column: string, value: string) => {
      const id = nextId();
      const row: Record<string, string> = {
        id,
        slug: slugOf(id),
        legal_name: "Shape Ltd",
        country: "SL",
        default_currency: "USD",
        default_language: "en",
        timezone: "Africa/Freetown",
        units: "metric",
        data_region: "af-south-1",
        [column]: value,
      };
      const names = Object.keys(row);
      return adminOutcome(
        `INSERT INTO bricx.organizations (${names.join(", ")}, created_at, updated_at)
         VALUES (${names.map((_, i) => `$${String(i + 1)}`).join(", ")}, now(), now())`,
        Object.values(row),
      );
    };
    for (const [column, value] of [
      ["id", randomUUID()],
      ["slug", "ab"],
      ["slug", "-acme"],
      ["slug", "Acme"],
      ["slug", "a".repeat(64)],
      ["legal_name", ""],
      ["legal_name", "x".repeat(201)],
      ["country", "sl"],
      ["country", "SLE"],
      ["default_currency", "usd"],
      ["default_language", "EN"],
      ["timezone", "Africa/Free town"],
      ["units", "imperial"],
      ["data_region", "Mars"],
      ["brand_color", "#ABCDEF"],
      ["brand_color", "red"],
      ["logo_object_key", ""],
    ] as const) {
      expect([column, value.slice(0, 20), await insert(column, value)]).toEqual(
        [column, value.slice(0, 20), CHECK],
      );
    }
    expect(await insert("brand_color", "#0a7cff")).toBe("ok:1");
  });

  test("roles.org_id and memberships.org_id reference organizations (P5-05 Also line): 23503 for a missing one", async () => {
    const missing = nextId();
    const user = await seedUser();
    const role = nextId();
    expect(
      await adminOutcome(
        `INSERT INTO bricx.roles (id, org_id, key, name, system_key, created_at, updated_at)
         VALUES ($1, $2, 'owner', 'owner', 'owner', now(), now())`,
        [role, missing],
      ),
    ).toBe(FK);
    const present = nextId();
    await seedOrg(present);
    await asAdmin(
      `INSERT INTO bricx.roles (id, org_id, key, name, system_key, created_at, updated_at)
       VALUES ($1, $2, 'owner', 'owner', 'owner', now(), now())`,
      [role, present],
    );
    expect(
      await asAdmin(
        `SELECT conname FROM pg_constraint
         WHERE conrelid IN ('bricx.roles'::regclass, 'bricx.memberships'::regclass)
           AND confrelid = 'bricx.organizations'::regclass
         ORDER BY conname`,
      ),
    ).toEqual([
      { conname: "memberships_org_id_organizations_id_fk" },
      { conname: "roles_org_id_organizations_id_fk" },
    ]);
    expect(
      await adminOutcome(
        `INSERT INTO bricx.memberships (id, org_id, user_id, role_id, created_at)
         VALUES ($1, $2, $3, $4, now())`,
        [nextId(), missing, user, role],
      ),
    ).toBe(FK);
  });
});

describe("migration 0009: bricx.org_create_attempts (R4, C2)", () => {
  const INSERT = `INSERT INTO bricx.org_create_attempts
    (user_id, key_hash, request_hash, org_id, slug, created_at)
    VALUES ($1, $2, $3, $4, $5, now())`;
  const hash = () => randomBytes(32);

  test("own rows only, in any org: another user neither sees nor writes them", async () => {
    const u1 = await seedUser();
    const u2 = await seedUser();
    const org = nextId();
    const key = hash();
    await asAdmin(INSERT, [u1, key, hash(), org, slugOf(org)]);
    expect(
      await outcome(
        "bricx_app",
        ctx(nextId(), u1),
        "SELECT org_id FROM bricx.org_create_attempts WHERE user_id = $1",
        [u1],
      ),
    ).toBe("ok:1");
    expect(
      await outcome(
        "bricx_app",
        ctx(nextId(), u2),
        "SELECT org_id FROM bricx.org_create_attempts WHERE user_id = $1",
        [u1],
      ),
    ).toBe("ok:0");
    const other = nextId();
    expect(
      await outcome("bricx_app", ctx(nextId(), u2), INSERT, [
        u1,
        hash(),
        hash(),
        other,
        slugOf(other),
      ]),
    ).toBe(DENIED);
    expect(
      await outcome(
        "bricx_app",
        ctx(nextId(), u2),
        "UPDATE bricx.org_create_attempts SET state = 'refused', settled_at = now() WHERE user_id = $1",
        [u1],
      ),
    ).toBe("ok:0");
  });

  test("the runbook's query (C2) lists pending attempts older than 24 h, oldest first, and nothing else; it changes nothing", async () => {
    const runbook = readFileSync(
      path.resolve(import.meta.dirname, "../../../docs/runbooks/migrations.md"),
      "utf8",
    );
    // The fenced sql block after the marker, found with indexOf: Semgrep's
    // parser fails on a regex literal holding backticks, and a RegExp from
    // a string is refused (bricx-regexp-non-literal).
    const fence = "`".repeat(3);
    const marker = runbook.indexOf("<!-- runbook:pending-attempts -->");
    expect(marker, "the runbook's pending-attempts marker").toBeGreaterThan(-1);
    const open = runbook.indexOf(`${fence}sql\n`, marker);
    expect(open, "the fenced sql block after the marker").toBeGreaterThan(-1);
    const body = open + fence.length + 4;
    const close = runbook.indexOf(fence, body);
    expect(close).toBeGreaterThan(body);
    expect(runbook.slice(marker, open).trim()).toBe(
      "<!-- runbook:pending-attempts -->",
    );
    const query = runbook.slice(body, close);
    expect(query).toMatch(/^SELECT /);
    expect(query).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/i);
    const u1 = await seedUser();
    const rows: [string, string, number][] = [
      ["old-pending", "pending", 30],
      ["older-pending", "pending", 48],
      ["new-pending", "pending", 2],
      ["old-committed", "committed", 30],
      ["old-refused", "refused", 30],
    ];
    const orgs: Record<string, string> = {};
    for (const [name, state, hours] of rows) {
      const org = nextId();
      orgs[name] = org;
      await asAdmin(
        `INSERT INTO bricx.org_create_attempts
           (user_id, key_hash, request_hash, org_id, slug, state, created_at, settled_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() - make_interval(hours => $7),
           CASE WHEN $6 = 'pending' THEN NULL ELSE now() END)`,
        [u1, hash(), hash(), org, slugOf(org), state, hours],
      );
    }
    // The database administrator runs it (FORCE RLS gives bricx_owner no
    // policy on this user table).
    const listed = (await asAdmin<{ user_id: string; org_id: string }>(query))
      .filter((r) => r.user_id === u1)
      .map((r) => r.org_id);
    expect(listed).toEqual([orgs["older-pending"], orgs["old-pending"]]);
  });

  test("(user, key hash) is the primary key; an org id belongs to one attempt", async () => {
    const u1 = await seedUser();
    const org = nextId();
    const key = hash();
    await asAdmin(INSERT, [u1, key, hash(), org, slugOf(org)]);
    const other = nextId();
    expect(
      await adminOutcome(INSERT, [u1, key, hash(), other, slugOf(other)]),
    ).toBe("23505");
    expect(
      await adminOutcome(INSERT, [
        await seedUser(),
        hash(),
        hash(),
        org,
        "x-y",
      ]),
    ).toBe("23505");
  });

  test("settles once, from pending to committed or refused; nothing else changes (P6003; column grant 42501)", async () => {
    const u1 = await seedUser();
    const org = nextId();
    const key = hash();
    await asAdmin(INSERT, [u1, key, hash(), org, slugOf(org)]);
    const c = ctx(nextId(), u1);
    expect(
      await outcome(
        "bricx_app",
        c,
        "UPDATE bricx.org_create_attempts SET state = 'committed' WHERE user_id = $1",
        [u1],
      ),
    ).toBe(CHECK);
    expect(
      await outcome(
        "bricx_app",
        c,
        "UPDATE bricx.org_create_attempts SET state = 'pending', settled_at = now() WHERE user_id = $1",
        [u1],
      ),
      // The BEFORE UPDATE trigger runs before the CHECK: pending is no
      // settled state.
    ).toBe(SETTLE_ONCE);
    for (const set of [
      `org_id = '${nextId()}'`,
      "slug = 'other-slug'",
      "request_hash = request_hash",
      "created_at = now()",
    ]) {
      expect([
        set,
        await outcome(
          "bricx_app",
          c,
          `UPDATE bricx.org_create_attempts SET ${set} WHERE user_id = $1`,
          [u1],
        ),
      ]).toEqual([set, DENIED]);
      expect([
        set,
        await adminOutcome(
          `UPDATE bricx.org_create_attempts SET ${set}, state = 'committed', settled_at = now() WHERE user_id = $1`,
          [u1],
        ),
      ]).toEqual([
        set,
        set === "request_hash = request_hash" ? "ok:1" : SETTLE_ONCE,
      ]);
    }
    // Commit it as bricx_app, for real.
    const client = await pg18.connectAs("bricx_app");
    try {
      await client.query("BEGIN");
      const q = dialect.sqlToQuery(
        contextStatement(validateTxContext(c), 30_000),
      );
      await client.query(q.sql, q.params);
      const r = await client.query(
        "UPDATE bricx.org_create_attempts SET state = 'committed', settled_at = now() WHERE user_id = $1 AND key_hash = $2",
        [u1, key],
      );
      expect(r.rowCount).toBe(1);
      await client.query("COMMIT");
    } finally {
      await client.end();
    }
    for (const state of ["refused", "pending", "committed"]) {
      expect([
        state,
        await outcome(
          "bricx_app",
          c,
          `UPDATE bricx.org_create_attempts SET state = '${state}', settled_at = ${state === "pending" ? "NULL" : "now()"} WHERE user_id = $1`,
          [u1],
        ),
      ]).toEqual([state, SETTLE_ONCE]);
    }
    expect(
      await adminOutcome(
        "UPDATE bricx.org_create_attempts SET state = 'refused' WHERE user_id = $1",
        [u1],
      ),
    ).toBe(SETTLE_ONCE);
  });

  test("nobody deletes an attempt: bricx_app has no DELETE (42501); the owner sees no row", async () => {
    const u1 = await seedUser();
    const org = nextId();
    await asAdmin(INSERT, [u1, hash(), hash(), org, slugOf(org)]);
    expect(
      await outcome(
        "bricx_app",
        ctx(nextId(), u1),
        "DELETE FROM bricx.org_create_attempts WHERE user_id = $1",
        [u1],
      ),
    ).toBe(DENIED);
    const owner = await outcome(
      "bricx_owner",
      ctx(nextId(), u1),
      "DELETE FROM bricx.org_create_attempts WHERE user_id = $1",
      [u1],
    );
    expect(owner === "ok:0" || owner === DENIED).toBe(true);
    expect(
      await asAdmin(
        "SELECT state FROM bricx.org_create_attempts WHERE user_id = $1",
        [u1],
      ),
    ).toEqual([{ state: "pending" }]);
  });

  test("the CHECKs: 32-byte hashes, a UUIDv7 org id, the slug shape, a known state", async () => {
    const u1 = await seedUser();
    const org = nextId();
    expect(
      await adminOutcome(INSERT, [
        u1,
        randomBytes(31),
        hash(),
        org,
        slugOf(org),
      ]),
    ).toBe(CHECK);
    expect(
      await adminOutcome(INSERT, [
        u1,
        hash(),
        randomBytes(33),
        org,
        slugOf(org),
      ]),
    ).toBe(CHECK);
    expect(
      await adminOutcome(INSERT, [u1, hash(), hash(), randomUUID(), "abc"]),
    ).toBe(CHECK);
    expect(await adminOutcome(INSERT, [u1, hash(), hash(), org, "A-b"])).toBe(
      CHECK,
    );
    expect(
      await adminOutcome(
        `INSERT INTO bricx.org_create_attempts
           (user_id, key_hash, request_hash, org_id, slug, state, created_at)
         VALUES ($1, $2, $3, $4, $5, 'abandoned', now())`,
        [u1, hash(), hash(), org, slugOf(org)],
      ),
    ).toBe(CHECK);
  });
});

describe("@bricx/db/organizations (PD-2)", () => {
  test("createOrganization(): the row, thirteen roles, the first owner, one users.mfa_check row and two audit events, in the caller's transaction", async () => {
    const owner = await seedUser();
    const id = nextId();
    const input = newOrganization(id, owner);
    const result = await app.withTx(ctx(id, owner), (tx) =>
      createOrganization(tx, deps(), input),
    );
    expect(result.organization).toEqual({
      id,
      slug: input.slug,
      legalName: "Acme Builders Ltd",
      country: "SL",
      defaultCurrency: "SLE",
      defaultLanguage: "en",
      timezone: "Africa/Freetown",
      units: "metric",
      dataRegion: "af-south-1",
      brandColor: "#0a7cff",
      logoObjectKey: null,
      createdAt: "2026-11-06T12:00:00.000000Z",
      updatedAt: "2026-11-06T12:00:00.000000Z",
      archivedAt: null,
    });
    expect(result.bootstrap.roles).toBe(ROLE_IDS.length);
    const roles = await asAdmin<{ system_key: string; n: string }>(
      `SELECT r.system_key, count(p.id)::text AS n
       FROM bricx.roles r LEFT JOIN bricx.role_permissions p ON p.role_id = r.id AND p.revoked_at IS NULL
       WHERE r.org_id = $1 GROUP BY r.system_key ORDER BY r.system_key`,
      [id],
    );
    expect(roles).toEqual(
      [...ROLE_IDS].sort().map((key) => ({
        system_key: key,
        n: String(key === "owner" ? 0 : ROLES[key].length),
      })),
    );
    expect(
      await asAdmin(
        `SELECT m.user_id::text AS user_id, r.system_key FROM bricx.memberships m
         JOIN bricx.roles r ON r.id = m.role_id WHERE m.org_id = $1`,
        [id],
      ),
    ).toEqual([{ user_id: owner, system_key: "owner" }]);
    expect(
      await asAdmin(
        "SELECT topic, payload FROM bricx.outbox WHERE org_id = $1",
        [id],
      ),
    ).toEqual([{ topic: "users.mfa_check", payload: { userId: owner } }]);
    expect(
      await asAdmin(
        `SELECT seq::text AS seq, action, entity_type, entity_id::text AS entity_id, actor_type, actor_id::text AS actor_id
         FROM bricx.audit_events WHERE org_id = $1 ORDER BY seq`,
        [id],
      ),
    ).toEqual([
      {
        seq: "1",
        action: "org.member.bootstrap",
        entity_type: "org.member",
        entity_id: result.bootstrap.membershipId,
        actor_type: "user",
        actor_id: owner,
      },
      {
        seq: "2",
        action: "org.organization.create",
        entity_type: "org.organization",
        entity_id: id,
        actor_type: "user",
        actor_id: owner,
      },
    ]);
    expect(
      await app.withTx(ctx(id, owner), (tx) => readOrganization(tx, id)),
    ).toEqual(result.organization);
  });

  test("an unknown owner is user_missing and nothing remains (the transaction rolls back)", async () => {
    const ghost = nextId();
    const id = nextId();
    const error = await app
      .withTx(ctx(id, ghost), (tx) =>
        createOrganization(tx, deps(), newOrganization(id, ghost)),
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BootstrapError);
    expect((error as BootstrapError).reason).toBe("user_missing");
    expect((error as Error).message).not.toContain(ghost);
    for (const table of ["organizations", "roles", "memberships"]) {
      const column = table === "organizations" ? "id" : "org_id";
      expect([
        table,
        await asAdmin(`SELECT 1 FROM bricx.${table} WHERE ${column} = $1`, [
          id,
        ]),
      ]).toEqual([table, []]);
    }
  });

  test("sabotage: creating from another organisation's context is refused by RLS (42501), nothing written", async () => {
    const owner = await seedUser();
    const id = nextId();
    const error = await app
      .withTx(ctx(nextId(), owner), (tx) =>
        createOrganization(tx, deps(), newOrganization(id, owner)),
      )
      .catch((e: unknown) => e);
    expect(sqlstateOf(error)).toBe(DENIED);
    expect(
      await asAdmin("SELECT 1 FROM bricx.organizations WHERE id = $1", [id]),
    ).toEqual([]);
  });

  test("bootstrapOrganization(): org_missing for a missing organisation, org_not_empty for one with a membership", async () => {
    const owner = await seedUser();
    const missing = nextId();
    const refusal = (orgId: string) =>
      app
        .withTx(ctx(orgId, owner), (tx) =>
          bootstrapOrganization(tx, deps(), {
            orgId,
            userId: owner,
            now: NOW,
          }),
        )
        .then(
          () => "ok",
          (e: unknown) => (e instanceof BootstrapError ? e.reason : String(e)),
        );
    expect(await refusal(missing)).toBe("org_missing");
    const empty = nextId();
    await seedOrg(empty);
    expect(await refusal(empty)).toBe("ok");
    expect(await refusal(empty)).toBe("org_not_empty");
  });
});
