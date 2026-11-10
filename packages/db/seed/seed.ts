// The seed writer (P6-05b, ADR 0076; binding decisions C1, D, G, H1;
// owner conditions 1 and 2): writes the dataset into the database `db`
// reaches, through withTx() only (CLAUDE.md rule 4), as bricx_app, so
// FORCE RLS applies to every tenant row exactly as for the app.
// - Each row: `INSERT … ON CONFLICT DO NOTHING` with no conflict target
//   (condition 1: any unique key, not only the id, makes it a no-op), then
//   read back by id and compared column by column with the dataset. A row
//   that is missing (another row holds one of its unique keys, or RLS hides
//   it) or differs stops the run with SeedDriftError, "seed drift: <table>
//   <id>", never a value; the seed never updates or deletes.
// - Every timestamp comes from the injected Clock, fixed to the seed
//   instant (G, condition 2); no column is left to a database default.
// - Users go through app.provision_user() (the only writer of
//   bricx.users, ADR 0062) with the committed id as the transaction's user
//   (architect call 4); an existing user is read back first, so a second
//   run calls nothing.
// - Per organisation, in order: one transaction for the organisation, its
//   org region config, roles and bundles; one per user; one for the
//   memberships, the project, its region config, sites, project members
//   and site assignments (the owner is the transaction's user: projects
//   and sites must be created_by the current user).
// - The first transaction checks current_user is bricx_app (condition 3);
//   any other role is SeedRoleError before a row is written.
// - No audit event and no outbox row is written (architect call 3, ADR
//   0076): seed rows are dev fixtures, not user actions.
import { type Clock, fixedClock } from "@bricx/domain/clock";
import canonicalize from "canonicalize";
import {
  type SQL,
  eq,
  getTableColumns,
  type InferInsertModel,
  sql,
} from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Database, Tx } from "../src/database.js";
import {
  memberships,
  organizations,
  projectMembershipSites,
  projectMemberships,
  projects,
  regionConfigs,
  rolePermissions,
  roles,
  sites,
  users,
} from "../src/schema/tables.js";
import { MAX_THROTTLE_SECONDS, provisionUser } from "../src/users.js";
import {
  SEED_INSTANT_MS,
  type SeedDataset,
  type SeedOrg,
  type SeedPolygon,
} from "./dataset.js";

/** The tables the seed writes, in the order the summary lists them. */
export const SEED_TABLES = [
  "organizations",
  "users",
  "region_configs",
  "roles",
  "role_permissions",
  "memberships",
  "projects",
  "sites",
  "project_memberships",
  "project_membership_sites",
] as const;
export type SeedTable = (typeof SEED_TABLES)[number];

/** The only role the seed runs as (C1, ADR 0035). */
export const SEED_ROLE = "bricx_app";

/** A stored row differs from the dataset, or is missing: table and id only. */
export class SeedDriftError extends Error {
  readonly table: SeedTable;
  readonly id: string;

  constructor(table: SeedTable, id: string) {
    super(`seed drift: ${table} ${id}`);
    this.table = table;
    this.id = id;
  }
}
Object.defineProperty(SeedDriftError.prototype, "name", {
  value: "SeedDriftError",
});

/** The database handle does not connect as bricx_app. */
export class SeedRoleError extends Error {
  constructor() {
    super("seed refused: the database user is not bricx_app");
  }
}
Object.defineProperty(SeedRoleError.prototype, "name", {
  value: "SeedRoleError",
});

export interface SeedResult {
  /** Rows this run inserted. */
  readonly inserted: number;
  /** Rows already stored, equal to the dataset. */
  readonly present: number;
  /** The dataset's rows per table (the same on every run). */
  readonly tables: Readonly<Record<SeedTable, number>>;
}

interface Tally {
  inserted: number;
  present: number;
  readonly tables: Record<SeedTable, number>;
}

type IdTable = PgTable & { readonly id: PgColumn };

/** A boundary to write as geography and compare as GeoJSON. */
interface Geo {
  readonly column: PgColumn;
  readonly value: SeedPolygon;
}

const isTimestamp = (column: PgColumn | undefined): boolean =>
  column?.columnType === "PgTimestampString";

/** Canonical JSON of a JSON-like value (key order ignored). */
const json = (value: unknown): string | undefined =>
  canonicalize(typeof value === "bigint" ? value.toString() : value);

/** True when a stored value equals the dataset's. */
function same(
  column: PgColumn | undefined,
  expected: unknown,
  actual: unknown,
): boolean {
  if (expected === null || actual === null) return expected === actual;
  if (isTimestamp(column)) {
    return (
      typeof expected === "string" &&
      typeof actual === "string" &&
      Date.parse(expected) === Date.parse(actual)
    );
  }
  if (typeof expected === "object") return json(expected) === json(actual);
  return expected === actual;
}

/**
 * Inserts `row` into `table` unless any unique key already holds it, then
 * reads the row back by id and compares every column in `row` (plus
 * `nulls`, which must be NULL, and `geo`). Counts it as inserted or
 * present; anything else is SeedDriftError.
 */
async function put<T extends IdTable>(
  tx: Tx,
  tally: Tally,
  name: SeedTable,
  table: T,
  row: InferInsertModel<T> & { readonly id: string },
  nulls: readonly string[] = [],
  geo?: Geo,
): Promise<void> {
  const values: Record<string, unknown> = { ...row };
  if (geo !== undefined) {
    values[geoKey(table, geo.column)] =
      sql`extensions.ST_GeomFromGeoJSON(${JSON.stringify(geo.value)})::extensions.geography`;
  }
  const inserted = await tx
    .insert(table)
    .values(values as InferInsertModel<T>)
    .onConflictDoNothing()
    .returning({ id: table.id });
  const columns = getTableColumns(table) as Record<string, PgColumn>;
  const expected: Record<string, unknown> = { ...row };
  for (const key of nulls) expected[key] = null;
  const selection: Record<string, PgColumn | SQL> = {};
  for (const key of Object.keys(expected)) {
    const column = columns[key];
    if (column === undefined) throw new Error("seed: unknown column");
    selection[key] = column;
  }
  if (geo !== undefined) {
    selection["boundary"] = sql<
      string | null
    >`extensions.ST_AsGeoJSON(${geo.column})`;
  }
  const source: PgTable = table;
  const [stored] = (await tx
    .select(selection)
    .from(source)
    .where(eq(table.id, row.id))) as Record<string, unknown>[];
  if (stored === undefined) throw new SeedDriftError(name, row.id);
  for (const [key, value] of Object.entries(expected)) {
    if (!same(columns[key], value, stored[key])) {
      throw new SeedDriftError(name, row.id);
    }
  }
  if (geo !== undefined) {
    const text = stored["boundary"];
    const boundary: unknown =
      typeof text === "string" ? JSON.parse(text) : null;
    if (json(boundary) !== json(geo.value)) {
      throw new SeedDriftError(name, row.id);
    }
  }
  tally.tables[name] += 1;
  if (inserted.length > 0) tally.inserted += 1;
  else tally.present += 1;
}

/** The property name of `column` in `table`. */
function geoKey(table: IdTable, column: PgColumn): string {
  for (const [key, candidate] of Object.entries(getTableColumns(table))) {
    if (candidate === column) return key;
  }
  throw new Error("seed: unknown geo column");
}

const REGION_FIELDS = [
  "currency",
  "reportingCurrency",
  "language",
  "timezone",
  "formatLocale",
  "units",
  "taxProfileId",
  "paymentAdapters",
  "accountingAdapter",
  "rateLibrary",
  "sessionIdleSeconds",
  "invitationTtlHours",
] as const;

/** The region-config field columns not in `set`, which must be NULL. */
const otherRegionFields = (set: readonly string[]): string[] =>
  REGION_FIELDS.filter((field) => !set.includes(field));

async function checkRole(tx: Tx): Promise<void> {
  const result = await tx.execute<{ role: unknown }>(
    sql`SELECT current_user::text AS role`,
  );
  if (result.rows[0]?.role !== SEED_ROLE) throw new SeedRoleError();
}

/** The organisation, its org region config, roles and bundles. */
async function writeOrganization(
  tx: Tx,
  tally: Tally,
  org: SeedOrg,
  now: string,
): Promise<void> {
  await put(
    tx,
    tally,
    "organizations",
    organizations,
    {
      id: org.id,
      slug: org.slug,
      legalName: org.legalName,
      country: org.country,
      defaultCurrency: org.defaultCurrency,
      defaultLanguage: org.defaultLanguage,
      timezone: org.timezone,
      units: org.units,
      dataRegion: org.dataRegion,
      createdAt: now,
      updatedAt: now,
    },
    ["brandColor", "logoObjectKey", "archivedAt"],
  );
  await put(
    tx,
    tally,
    "region_configs",
    regionConfigs,
    {
      id: org.regionConfig.id,
      orgId: org.id,
      reportingCurrency: org.regionConfig.reportingCurrency,
      formatLocale: org.regionConfig.formatLocale,
      createdAt: now,
      updatedAt: now,
    },
    ["projectId", ...otherRegionFields(["reportingCurrency", "formatLocale"])],
  );
  for (const role of org.roles) {
    await put(
      tx,
      tally,
      "roles",
      roles,
      {
        id: role.id,
        orgId: org.id,
        key: role.key,
        name: role.key,
        systemKey: role.key,
        createdAt: now,
        updatedAt: now,
      },
      ["archivedAt"],
    );
    for (const grant of role.permissions) {
      await put(
        tx,
        tally,
        "role_permissions",
        rolePermissions,
        {
          id: grant.id,
          orgId: org.id,
          roleId: role.id,
          permission: grant.permission,
          grantedAt: now,
        },
        ["revokedAt"],
      );
    }
  }
}

/** One user, provisioned with its committed id (architect call 4). */
async function writeUser(
  tx: Tx,
  tally: Tally,
  user: { readonly id: string; readonly sub: string },
  now: string,
): Promise<void> {
  const read = () =>
    tx
      .select({ sub: users.keycloakSub, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.id, user.id));
  let [stored] = await read();
  let fresh = false;
  if (stored === undefined) {
    const id = await provisionUser(tx, {
      sub: user.sub,
      now,
      throttleSeconds: MAX_THROTTLE_SECONDS,
    });
    if (id !== user.id) throw new SeedDriftError("users", user.id);
    [stored] = await read();
    fresh = true;
  }
  if (
    stored === undefined ||
    stored.sub !== user.sub ||
    Date.parse(stored.createdAt) !== Date.parse(now)
  ) {
    throw new SeedDriftError("users", user.id);
  }
  tally.tables.users += 1;
  if (fresh) tally.inserted += 1;
  else tally.present += 1;
}

/** Memberships, the project and everything under it. */
async function writeProject(
  tx: Tx,
  tally: Tally,
  org: SeedOrg,
  now: string,
): Promise<void> {
  const roleId = new Map(org.roles.map((role) => [role.key, role.id]));
  for (const user of org.users) {
    const role = roleId.get(user.role);
    if (role === undefined) throw new Error("seed: unknown role");
    await put(
      tx,
      tally,
      "memberships",
      memberships,
      {
        id: user.membershipId,
        orgId: org.id,
        userId: user.id,
        roleId: role,
        createdAt: now,
      },
      ["removedAt"],
    );
  }
  const { project } = org;
  await put(
    tx,
    tally,
    "projects",
    projects,
    {
      id: project.id,
      orgId: org.id,
      code: project.code,
      name: project.name,
      clientName: project.clientName,
      status: project.status,
      currency: project.currency,
      reportingCurrency: project.reportingCurrency,
      timezone: project.timezone,
      startDate: project.startDate,
      endDate: project.endDate,
      createdBy: project.createdBy,
      createdAt: now,
      updatedAt: now,
    },
    ["contractValueMinor", "contractValueCurrency", "archivedAt"],
  );
  await put(
    tx,
    tally,
    "region_configs",
    regionConfigs,
    {
      id: project.regionConfig.id,
      orgId: org.id,
      projectId: project.id,
      language: project.regionConfig.language,
      formatLocale: project.regionConfig.formatLocale,
      createdAt: now,
      updatedAt: now,
    },
    otherRegionFields(["language", "formatLocale"]),
  );
  for (const site of org.sites) {
    await put(
      tx,
      tally,
      "sites",
      sites,
      {
        id: site.id,
        orgId: org.id,
        projectId: project.id,
        name: site.name,
        address: site.address,
        geofenceRadiusM: 0,
        createdBy: project.createdBy,
        createdAt: now,
        updatedAt: now,
      },
      ["archivedAt"],
      { column: sites.geom, value: site.boundary },
    );
  }
  for (const member of org.projectMembers) {
    await put(
      tx,
      tally,
      "project_memberships",
      projectMemberships,
      {
        id: member.id,
        orgId: org.id,
        projectId: project.id,
        userId: member.userId,
        roleId: member.roleId,
        overrides: {},
        createdAt: now,
      },
      ["removedAt"],
    );
  }
  for (const assignment of org.siteAssignments) {
    await put(
      tx,
      tally,
      "project_membership_sites",
      projectMembershipSites,
      {
        id: assignment.id,
        orgId: org.id,
        projectId: project.id,
        projectMembershipId: assignment.projectMembershipId,
        userId: assignment.userId,
        siteId: assignment.siteId,
        createdAt: now,
      },
      ["removedAt"],
    );
  }
}

/**
 * Writes `dataset` through `db` (a bricx_app handle) and returns the
 * counts; SeedDriftError or SeedRoleError stop it. Idempotent: a second
 * run inserts nothing.
 */
export async function runSeed(
  db: Database,
  dataset: SeedDataset,
  clock: Clock = fixedClock(SEED_INSTANT_MS),
): Promise<SeedResult> {
  const now = new Date(clock.now()).toISOString();
  const tally: Tally = {
    inserted: 0,
    present: 0,
    tables: Object.fromEntries(SEED_TABLES.map((t) => [t, 0])) as Record<
      SeedTable,
      number
    >,
  };
  let roleChecked = false;
  for (const org of dataset.orgs) {
    const owner = org.users.find((user) => user.role === "owner");
    if (owner === undefined) throw new Error("seed: no owner");
    const context = {
      orgId: org.id,
      userId: owner.id,
      projectIds: [org.project.id],
    };
    await db.withTx(context, async (tx) => {
      if (!roleChecked) await checkRole(tx);
      roleChecked = true;
      await writeOrganization(tx, tally, org, now);
    });
    for (const user of org.users) {
      await db.withTx(
        { orgId: org.id, userId: user.id, projectIds: [] },
        (tx) => writeUser(tx, tally, user, now),
      );
    }
    await db.withTx(context, (tx) => writeProject(tx, tally, org, now));
  }
  return {
    inserted: tally.inserted,
    present: tally.present,
    tables: Object.freeze({ ...tally.tables }),
  };
}
