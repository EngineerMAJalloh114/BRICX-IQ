// Organisations' shared transactional core (P6-02, ADR 0072; phase
// decision PD-2): the writes that make an organisation, in the caller's
// withTx() transaction, so the API (POST /v1/organizations), the
// membership:bootstrap CLI and the P6-05b seed write the same rows the same
// way.
// - createOrganization(): the organisations row (the transaction's org is
//   the new id: RLS admits only that row), then bootstrapOrganization(),
//   then the audit event org.organization.create. The id comes from the
//   caller (the create attempt's UUIDv7, ADR 0072), never the default.
// - bootstrapOrganization() (moved from the API's memberships module,
//   P5-05, ADR 0066): an existing, empty organisation's twelve roles (owner
//   virtual: system_key alone; the other eleven bundles copied as open
//   role_permissions rows), the first owner's membership, one
//   users.mfa_check outbox row (an owner holds finance keys) and one
//   org.member.bootstrap audit event, last. Refused when the organisation
//   does not exist (org_missing; the FK since P6-02), already has a
//   membership row (org_not_empty), or the user does not exist
//   (user_missing; the FK, the transaction's earlier rows roll back with
//   it).
// Ids and the clock are injected (CLAUDE.md rules 6 and 7); the audit
// origin (correlation id, ip, device) is the caller's. Errors carry a
// code, never a value.
import { ROLE_IDS, ROLES } from "@bricx/permissions/roles";
import { count, eq, sql } from "drizzle-orm";
import { type AuditOriginInput, recordAuditEvent } from "./audit.js";
import { type Tx, sqlstateOf } from "./database.js";
import { insertOutbox } from "./outbox.js";
import {
  memberships,
  organizations,
  rolePermissions,
  roles,
} from "./schema/tables.js";

/** The catalogue resource of an organisation (ADR 0048). */
export const ORGANIZATION_SUBJECT = "org.organization";
/** The catalogue resource of a membership. */
const MEMBER_SUBJECT = "org.member";
/** The outbox topic the worker's MFA consumer reads (P5-05, ADR 0066). */
const USERS_MFA_CHECK = "users.mfa_check";
const FOREIGN_KEY_VIOLATION = "23503";

/** What the writes need besides the transaction. */
export interface OrganizationDeps {
  /** The instant every audit event records (the injected Clock). */
  readonly clock: { now(): number };
  /** UUIDv7s for every new row, the audit events and the outbox row. */
  readonly ids: { next(): string };
  /** The audit events' origin (the request's, or a CLI's correlation id). */
  readonly origin: AuditOriginInput;
}

export type BootstrapRefusal = "org_missing" | "org_not_empty" | "user_missing";

/** bootstrapOrganization() refused: a code, never a value. */
export class BootstrapError extends Error {
  readonly reason: BootstrapRefusal;

  constructor(reason: BootstrapRefusal) {
    super(`membership bootstrap refused: ${reason}`);
    this.reason = reason;
  }
}
Object.defineProperty(BootstrapError.prototype, "name", {
  value: "BootstrapError",
});

export interface BootstrapInput {
  readonly orgId: string;
  readonly userId: string;
  /** UTC ISO 8601. */
  readonly now: string;
}

export interface BootstrapResult {
  readonly membershipId: string;
  readonly ownerRoleId: string;
  readonly roles: number;
}

/** The measurement systems an organisation may default to (@bricx/domain). */
export type OrganizationUnits = "metric" | "us_customary";

/** A new organisation, validated by the caller (the API's DTO, the seed). */
export interface NewOrganization {
  /** The create attempt's UUIDv7; also the transaction's org. */
  readonly id: string;
  readonly slug: string;
  readonly legalName: string;
  readonly country: string;
  readonly defaultCurrency: string;
  readonly defaultLanguage: string;
  readonly timezone: string;
  readonly units: OrganizationUnits;
  /** This cell's id (CELL_ID). */
  readonly dataRegion: string;
  readonly brandColor: string | null;
  /** The first owner (users.id); the transaction's user. */
  readonly ownerId: string;
  /** UTC ISO 8601: created_at and updated_at. */
  readonly now: string;
}

/** An organisations row, timestamps as UTC ISO 8601 (microseconds). */
export interface OrganizationRow {
  readonly id: string;
  readonly slug: string;
  readonly legalName: string;
  readonly country: string;
  readonly defaultCurrency: string;
  readonly defaultLanguage: string;
  readonly timezone: string;
  readonly units: string;
  readonly dataRegion: string;
  readonly brandColor: string | null;
  readonly logoObjectKey: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

const iso = (column: typeof organizations.createdAt) =>
  sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const isoOrNull = (column: typeof organizations.archivedAt) =>
  sql<
    string | null
  >`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** The columns every read and write returns. */
export const ORGANIZATION_COLUMNS = {
  id: organizations.id,
  slug: organizations.slug,
  legalName: organizations.legalName,
  country: organizations.country,
  defaultCurrency: organizations.defaultCurrency,
  defaultLanguage: organizations.defaultLanguage,
  timezone: organizations.timezone,
  units: organizations.units,
  dataRegion: organizations.dataRegion,
  brandColor: organizations.brandColor,
  logoObjectKey: organizations.logoObjectKey,
  createdAt: iso(organizations.createdAt),
  updatedAt: iso(organizations.updatedAt),
  archivedAt: isoOrNull(organizations.archivedAt),
};

/** The organisation `id`, when the transaction's RLS lets it be seen. */
export async function readOrganization(
  tx: Tx,
  id: string,
): Promise<OrganizationRow | undefined> {
  const [row] = await tx
    .select(ORGANIZATION_COLUMNS)
    .from(organizations)
    .where(eq(organizations.id, id));
  return row;
}

/** Writes an empty organisation's roles and first owner in `tx` (see the header). */
export async function bootstrapOrganization(
  tx: Tx,
  deps: OrganizationDeps,
  input: BootstrapInput,
): Promise<BootstrapResult> {
  const org = await readOrganization(tx, input.orgId);
  if (org === undefined) throw new BootstrapError("org_missing");
  const [existing] = await tx
    .select({ n: count() })
    .from(memberships)
    .where(eq(memberships.orgId, input.orgId));
  if ((existing?.n ?? 0) > 0) throw new BootstrapError("org_not_empty");
  let ownerRoleId: string | undefined;
  for (const key of ROLE_IDS) {
    const roleId = deps.ids.next();
    await tx.insert(roles).values({
      id: roleId,
      orgId: input.orgId,
      key,
      name: key,
      systemKey: key,
      createdAt: input.now,
      updatedAt: input.now,
    });
    if (key === "owner") {
      ownerRoleId = roleId;
      continue;
    }
    const keys = ROLES[key];
    if (keys.length > 0) {
      await tx.insert(rolePermissions).values(
        keys.map((permission) => ({
          id: deps.ids.next(),
          orgId: input.orgId,
          roleId,
          permission,
          grantedAt: input.now,
        })),
      );
    }
  }
  if (ownerRoleId === undefined) throw new Error("no owner role");
  const membershipId = deps.ids.next();
  try {
    await tx.insert(memberships).values({
      id: membershipId,
      orgId: input.orgId,
      userId: input.userId,
      roleId: ownerRoleId,
      createdAt: input.now,
    });
  } catch (error) {
    if (sqlstateOf(error) === FOREIGN_KEY_VIOLATION) {
      throw new BootstrapError("user_missing");
    }
    throw error;
  }
  await insertOutbox(
    tx,
    USERS_MFA_CHECK,
    { userId: input.userId },
    deps.ids.next(),
  );
  await recordAuditEvent(
    tx,
    { clock: deps.clock, ids: deps.ids, actor: "user" },
    {
      action: `${MEMBER_SUBJECT}.bootstrap`,
      entityType: MEMBER_SUBJECT,
      entityId: membershipId,
      after: {
        userId: input.userId,
        roleId: ownerRoleId,
        roles: ROLE_IDS.length,
      },
    },
    deps.origin,
  );
  return { membershipId, ownerRoleId, roles: ROLE_IDS.length };
}

/**
 * Creates the organisation `input.id` in `tx` (whose org is that id and
 * whose user is the owner): the row, its roles and first owner, and the
 * audit event org.organization.create, last.
 */
export async function createOrganization(
  tx: Tx,
  deps: OrganizationDeps,
  input: NewOrganization,
): Promise<{
  readonly organization: OrganizationRow;
  readonly bootstrap: BootstrapResult;
}> {
  const [organization] = await tx
    .insert(organizations)
    .values({
      id: input.id,
      slug: input.slug,
      legalName: input.legalName,
      country: input.country,
      defaultCurrency: input.defaultCurrency,
      defaultLanguage: input.defaultLanguage,
      timezone: input.timezone,
      units: input.units,
      dataRegion: input.dataRegion,
      brandColor: input.brandColor,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning(ORGANIZATION_COLUMNS);
  if (organization === undefined) throw new Error("insert returned no row");
  const bootstrap = await bootstrapOrganization(tx, deps, {
    orgId: input.id,
    userId: input.ownerId,
    now: input.now,
  });
  await recordAuditEvent(
    tx,
    { clock: deps.clock, ids: deps.ids, actor: "user" },
    {
      action: `${ORGANIZATION_SUBJECT}.create`,
      entityType: ORGANIZATION_SUBJECT,
      entityId: input.id,
      after: {
        slug: organization.slug,
        legalName: organization.legalName,
        country: organization.country,
        defaultCurrency: organization.defaultCurrency,
        defaultLanguage: organization.defaultLanguage,
        timezone: organization.timezone,
        units: organization.units,
        dataRegion: organization.dataRegion,
        brandColor: organization.brandColor,
      },
    },
    deps.origin,
  );
  return { organization, bootstrap };
}
