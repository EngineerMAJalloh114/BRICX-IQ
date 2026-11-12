// drizzle-kit's entry (drizzle.config.ts): every table, and nothing else.
// Never export a pgSchema() from here (see namespace.ts).
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, orgId } from "./columns.js";
import { bricx } from "./namespace.js";

/**
 * PostGIS geography (P6-05, ADR 0075): drizzle-orm 0.45.4 has geometry
 * but no geography column. The type lives in schema extensions (the
 * superuser bootstrap installs PostGIS there; the app role never runs
 * CREATE EXTENSION). Read and written as SQL expressions by the callers
 * (ST_AsGeoJSON / ST_GeomFromGeoJSON), never as a driver value.
 */
const geography = customType<{ data: string; driverData: string }>({
  dataType: () => "extensions.geography",
});

/** bytea as a Buffer (drizzle-orm 0.45.4 has no built-in bytea column). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * The audit log (P4-05, ADR 0055): one hash chain per org, append-only.
 * AuditService.record() writes it; `audit:verify` walks it. Every column
 * except prev_hash and hash is hashed; ADR 0055 pins each one's
 * serialisation. The migration appends `pnpm db:rls bricx.audit_events
 * org.audit` (UPDATE and DELETE revoked from bricx_app) and the
 * statement-level append-only triggers by hand.
 */
export const auditEvents = bricx.table(
  "audit_events",
  {
    /** UUIDv7 from record() (CLAUDE.md rule 6): it is hashed, so the API
     * always supplies it; uuidv7() is only the column helper's default. */
    id: id(),
    orgId: orgId(),
    /** 1, 2, 3, ... per org: the chain's order. */
    seq: bigint("seq", { mode: "bigint" }).notNull(),
    hashVersion: smallint("hash_version").notNull(),
    /** From the injected Clock, at millisecond precision. */
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    actorType: text("actor_type").notNull(),
    actorId: uuid("actor_id"),
    deviceId: uuid("device_id"),
    /** A host address only (/32 or /128). */
    ip: inet("ip"),
    /** {"lat_e6": int, "lon_e6": int}: integer micro-degrees, never floats. */
    geo: jsonb("geo"),
    correlationId: text("correlation_id").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    prevHash: bytea("prev_hash").notNull(),
    hash: bytea("hash").notNull(),
  },
  (t) => [
    unique("audit_events_org_seq").on(t.orgId, t.seq),
    // P6-06b (ADR 0084, C7): the member activity read.
    index("audit_events_by_actor").on(t.orgId, t.actorId, t.seq.desc()),
    index("audit_events_by_entity").on(
      t.orgId,
      t.entityType,
      t.entityId,
      t.seq.desc(),
    ),
    check("audit_events_seq", sql`${t.seq} >= 1`),
    check("audit_events_hash_version", sql`${t.hashVersion} >= 1`),
    check(
      "audit_events_occurred_at_ms",
      sql`${t.occurredAt} = date_trunc('milliseconds', ${t.occurredAt})`,
    ),
    check(
      "audit_events_actor",
      sql`${t.actorType} IN ('user', 'system') AND (${t.actorType} <> 'user' OR ${t.actorId} IS NOT NULL)`,
    ),
    check(
      "audit_events_ip_host",
      sql`masklen(${t.ip}) = CASE family(${t.ip}) WHEN 4 THEN 32 ELSE 128 END`,
    ),
    check(
      "audit_events_hash_length",
      sql`octet_length(${t.prevHash}) = 32 AND octet_length(${t.hash}) = 32`,
    ),
  ],
);

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });

/**
 * The transactional outbox (P4-06, ADR 0056). insertOutbox() (bricx_app)
 * writes id, org_id, topic and payload in the caller's transaction; the
 * worker's relay (bricx_relay) publishes pending rows to BullMQ with
 * jobId = id and updates only the delivery columns. Payloads carry ids,
 * never personal data. The migration appends enableOutboxRls() by hand.
 */
export const outbox = bricx.table(
  "outbox",
  {
    /** UUIDv7 from the API (insertOutbox() always supplies it). */
    id: id(),
    orgId: orgId(),
    /** A registered topic (@bricx/db/outbox), e.g. system.ping. */
    topic: text("topic").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
    // Delivery columns: the only ones bricx_relay may UPDATE.
    publishedAt: timestamptz("published_at"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamptz("next_attempt_at").notNull().defaultNow(),
    /** A failure code (e.g. unknown_topic), never an error message. */
    lastError: text("last_error"),
    deadAt: timestamptz("dead_at"),
    /**
     * P5-06 (D-G, ADR 0067; amends ADR 0056): publish no earlier than this
     * instant. The relay still claims the row at once and adds the job
     * with a delay (the table never holds a long-lived row). NULL: at
     * once. bricx_app may INSERT it; nobody updates it.
     */
    notBefore: timestamptz("not_before"),
  },
  (t) => [
    check("outbox_topic", sql`${t.topic} ~ '^[a-z][a-z0-9_.]{0,62}$'`),
    check("outbox_attempts", sql`${t.attempts} >= 0`),
    check(
      "outbox_published_or_dead",
      sql`NOT (${t.publishedAt} IS NOT NULL AND ${t.deadAt} IS NOT NULL)`,
    ),
    check(
      "outbox_last_error_code",
      sql`${t.lastError} ~ '^[a-z][a-z0-9_]{0,63}$'`,
    ),
    // The relay's claim: pending rows, oldest first.
    index("outbox_pending")
      .on(t.createdAt, t.id)
      .where(sql`${t.publishedAt} IS NULL AND ${t.deadAt} IS NULL`),
  ],
);

/**
 * Idempotency keys (P4-07, ADR 0057, decision 5b). One row per
 * (org, user, route, key): the request's fingerprint, the declared
 * status, and after COMMIT the serialised response text with its
 * replayable headers (content-type, location, etag), kept for 24 h.
 * Stored responses are plaintext: no secrets in idempotent responses, at
 * most 256 KiB. Expired rows are reused in place; the purge is P13's. The
 * migration appends enableIdempotencyRls() by hand.
 */
export const idempotencyKeys = bricx.table(
  "idempotency_keys",
  {
    id: id(),
    orgId: orgId(),
    userId: uuid("user_id").notNull(),
    /** "METHOD /path" without a query string, e.g. "POST /v1/expenses". */
    route: text("route").notNull(),
    /** The client's Idempotency-Key: 1-255 of [A-Za-z0-9._~-]. */
    key: text("key").notNull(),
    /** SHA-256 of RFC 8785 canonical JSON of { body, query }. */
    requestHash: bytea("request_hash").notNull(),
    status: smallint("status").notNull(),
    /** The exact serialised body, sent verbatim on replay. */
    response: text("response"),
    /** {"content-type": ..., "location"?: ..., "etag"?: ...}. */
    headers: jsonb("headers"),
    createdAt: createdAt(),
    expiresAt: timestamptz("expires_at")
      .notNull()
      .default(sql`now() + make_interval(secs => 86400)`),
  },
  (t) => [
    unique("idempotency_keys_scope").on(t.orgId, t.userId, t.route, t.key),
    check("idempotency_keys_key", sql`${t.key} ~ '^[A-Za-z0-9._~-]{1,255}$'`),
    // Postgres bounds a repeat at 255, so the path length is its own term:
    // method (10) + space + "/" + 2047.
    check(
      "idempotency_keys_route",
      sql`${t.route} ~ '^[A-Z]{3,10} /[!"$->@-~]*$' AND octet_length(${t.route}) <= 2059`,
    ),
    check(
      "idempotency_keys_hash_length",
      sql`octet_length(${t.requestHash}) = 32`,
    ),
    check("idempotency_keys_status", sql`${t.status} BETWEEN 100 AND 599`),
    check(
      "idempotency_keys_response_size",
      sql`octet_length(${t.response}) <= 262144`,
    ),
    check(
      "idempotency_keys_complete",
      sql`(${t.response} IS NULL) = (${t.headers} IS NULL)`,
    ),
    check(
      "idempotency_keys_headers_object",
      sql`jsonb_typeof(${t.headers}) = 'object'`,
    ),
    check("idempotency_keys_expiry", sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

/**
 * The people who have signed in (P5-02, phase ruling D8, ADR 0062): one
 * row per Keycloak subject, nothing personal (name and e-mail stay in
 * Keycloak). Global: users span organisations through P5-05 memberships,
 * so there is no org_id. The migration appends enableUsersRls() (FORCE,
 * own-row reads, no writes for bricx_app) and app.provision_user(), the
 * only writer. Both timestamps come from the API's Clock.
 */
export const users = bricx.table(
  "users",
  {
    /** A UUIDv7: the provisioning transaction's candidate user id. */
    id: id(),
    keycloakSub: text("keycloak_sub").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    /** Moved forward by provision_user(), at most once per throttle. */
    lastSeenAt: timestamp("last_seen_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (t) => [
    unique("users_keycloak_sub").on(t.keycloakSub),
    check("users_id_v7", sql`uuid_extract_version(${t.id}) = 7`),
    check(
      "users_keycloak_sub_length",
      sql`char_length(${t.keycloakSub}) BETWEEN 1 AND 255`,
    ),
    check("users_last_seen", sql`${t.lastSeenAt} >= ${t.createdAt}`),
  ],
);

/**
 * Registered devices (P5-03, phase ruling D9 as settled by the task plan,
 * ADR 0063): one row per physical device, owned by one user (user_id ->
 * users) and global like users, since a device that signs into two
 * organisations is still one device. The id is a UUIDv7 the device makes
 * once (CLAUDE.md rule 6). bricx_app sees and writes its own rows only and
 * may UPDATE name, last_seen_at and revoked_at only (enableOwnedRls, owner
 * condition 1); `trusted` is P5-07's (nothing sets it before MFA); a
 * revocation never goes back (trigger bricx.forbid_unrevoke). Both
 * timestamps come from the API's Clock.
 */
export const devices = bricx.table(
  "devices",
  {
    /** The device's own UUIDv7 (the server default is never used by the API). */
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** ios, android or web. */
    platform: text("platform").notNull(),
    /** A label the user chose, 1-100 characters. */
    name: text("name").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    lastSeenAt: timestamptz("last_seen_at").notNull(),
    /** P5-07 (MFA) decides who sets it; false until then. */
    trusted: boolean("trusted").notNull().default(false),
    /** Set once by a revoke; never cleared. */
    revokedAt: timestamptz("revoked_at"),
  },
  (t) => [
    index("devices_user").on(t.userId),
    check("devices_id_v7", sql`uuid_extract_version(${t.id}) = 7`),
    check("devices_platform", sql`${t.platform} IN ('ios', 'android', 'web')`),
    check("devices_name_length", sql`char_length(${t.name}) BETWEEN 1 AND 100`),
    check("devices_last_seen", sql`${t.lastSeenAt} >= ${t.createdAt}`),
    check("devices_revoked", sql`${t.revokedAt} >= ${t.createdAt}`),
  ],
);

/**
 * Sessions (P5-03, ADR 0063): one row per (organisation signed into,
 * Keycloak session), keyed by the token's `sid`; the device the request
 * carried, if any. Tenant table of resource org.session: the migration
 * appends `pnpm db:rls bricx.sessions org.session` verbatim plus the
 * own-row policies on user_id alone (enableOwnRowPolicies), so a user
 * reads and revokes their own sessions in every organisation (owner
 * condition 3). The guard upserts by (org_id, keycloak_sid); a revocation
 * never goes back and the identifying columns never change (trigger
 * bricx.sessions_immutable). Both timestamps come from the API's Clock.
 */
export const sessions = bricx.table(
  "sessions",
  {
    /** A UUIDv7 the guard makes on first sight. */
    id: id(),
    orgId: orgId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** The device whose registered X-Device-Id the request carried. */
    deviceId: uuid("device_id").references(() => devices.id),
    /** The access token's `sid` claim, 1-255 characters. */
    keycloakSid: text("keycloak_sid").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    /** Moved forward by the guard, at most once per throttle. */
    lastSeenAt: timestamptz("last_seen_at").notNull(),
    /** Set once by a revoke or the idle check; never cleared. */
    revokedAt: timestamptz("revoked_at"),
  },
  (t) => [
    unique("sessions_org_sid").on(t.orgId, t.keycloakSid),
    index("sessions_user").on(t.userId),
    check("sessions_id_v7", sql`uuid_extract_version(${t.id}) = 7`),
    check(
      "sessions_keycloak_sid_length",
      sql`char_length(${t.keycloakSid}) BETWEEN 1 AND 255`,
    ),
    check("sessions_last_seen", sql`${t.lastSeenAt} >= ${t.createdAt}`),
    check("sessions_revoked", sql`${t.revokedAt} >= ${t.createdAt}`),
  ],
);

/**
 * Organisations (P6-02, ADR 0072): one row per organisation served by this
 * cell. The id is the UUIDv7 the API fixed in the caller's create attempt
 * (bricx.org_create_attempts) before the directory reservation, so a retry
 * reuses it. Tenant table of resource org.organization, whose tenant
 * column is the id itself (app.current_org() = id). The slug is the one
 * reserved in the global directory (ADR 0071) and data_region is this
 * cell's id (CELL_ID): neither ever changes, for any role (trigger
 * bricx.organizations_immutable, SQLSTATE P6002), nor do id and
 * created_at; archived_at is set once by an archive and never moved; only
 * bricx_owner clears it (the restore runbook, D16). No hard delete: no
 * DELETE policy under FORCE. bricx_app may UPDATE only
 * the editable columns (restrictTenantUpdate, TENANT_UPDATE_COLUMNS).
 * Codes are checked against ISO 3166-1 alpha-2, ISO 4217 and tzdb by the
 * API; the CHECKs here hold their shapes. Not synced. Timestamps come
 * from the API's Clock.
 */
export const organizations = bricx.table(
  "organizations",
  {
    /** The UUIDv7 of the create attempt (never the column default). */
    id: id(),
    /** 3-63 of [a-z0-9-], the directory's shape; immutable. */
    slug: text("slug").notNull(),
    /** 1-200 characters. */
    legalName: text("legal_name").notNull(),
    /** ISO 3166-1 alpha-2. */
    country: text("country").notNull(),
    /** ISO 4217. */
    defaultCurrency: text("default_currency").notNull(),
    /** A supported BCP 47 locale (en, fr, ar). */
    defaultLanguage: text("default_language").notNull(),
    /** A tzdb zone name (zone.tab, tzdb 2026e). */
    timezone: text("timezone").notNull(),
    /** metric or us_customary. */
    units: text("units").notNull(),
    /** This cell's id (CELL_ID); immutable. */
    dataRegion: text("data_region").notNull(),
    /** #rrggbb, lower case, or NULL. */
    brandColor: text("brand_color"),
    /** The logo's object key (written by a later task, P8), or NULL. */
    logoObjectKey: text("logo_object_key"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    /** Set once by an archive; never cleared. */
    archivedAt: timestamptz("archived_at"),
  },
  (t) => [
    unique("organizations_slug").on(t.slug),
    check("organizations_id_v7", sql`uuid_extract_version(${t.id}) = 7`),
    check(
      "organizations_slug_shape",
      sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'`,
    ),
    check(
      "organizations_legal_name_length",
      sql`char_length(${t.legalName}) BETWEEN 1 AND 200`,
    ),
    check("organizations_country", sql`${t.country} ~ '^[A-Z]{2}$'`),
    check(
      "organizations_default_currency",
      sql`${t.defaultCurrency} ~ '^[A-Z]{3}$'`,
    ),
    check(
      "organizations_default_language",
      sql`${t.defaultLanguage} ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$'`,
    ),
    check(
      "organizations_timezone",
      sql`${t.timezone} ~ '^[A-Za-z0-9_+/-]{1,64}$'`,
    ),
    check("organizations_units", sql`${t.units} IN ('metric', 'us_customary')`),
    check(
      "organizations_data_region",
      sql`${t.dataRegion} ~ '^[a-z]{2}(-[a-z]+)+-[0-9]+$' AND char_length(${t.dataRegion}) <= 32`,
    ),
    check("organizations_brand_color", sql`${t.brandColor} ~ '^#[0-9a-f]{6}$'`),
    check(
      "organizations_logo_object_key",
      sql`char_length(${t.logoObjectKey}) BETWEEN 1 AND 1024`,
    ),
    check("organizations_updated", sql`${t.updatedAt} >= ${t.createdAt}`),
    check("organizations_archived", sql`${t.archivedAt} >= ${t.createdAt}`),
  ],
);

/**
 * A user's attempts to create an organisation (P6-02, ADR 0072; owner
 * ruling R4, condition C2): one row per (user, Idempotency-Key), written in
 * its own transaction before the directory reservation, so the
 * organisation id (org_id, a UUIDv7) is fixed before anything global is
 * written and a retry with the same key reuses it. key_hash and
 * request_hash are SHA-256 digests (the key itself is never stored);
 * state moves once, from pending to committed (the organisation's
 * transaction) or refused (the slug was taken), and nothing else ever
 * changes (trigger bricx.org_create_attempts_transition, SQLSTATE P6003).
 * The per-user cap counts pending and committed rows (an archived
 * organisation stays counted). A user table (USER_TABLES, enableOwnedRls):
 * bricx_app sees and writes its own rows only, may UPDATE state and
 * settled_at only, and nobody deletes. Not synced. Timestamps come from
 * the API's Clock.
 */
export const orgCreateAttempts = bricx.table(
  "org_create_attempts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    keyHash: bytea("key_hash").notNull(),
    requestHash: bytea("request_hash").notNull(),
    orgId: uuid("org_id").notNull(),
    slug: text("slug").notNull(),
    state: text("state").notNull().default("pending"),
    createdAt: timestamptz("created_at").notNull(),
    settledAt: timestamptz("settled_at"),
  },
  (t) => [
    primaryKey({
      name: "org_create_attempts_pkey",
      columns: [t.userId, t.keyHash],
    }),
    unique("org_create_attempts_org_id").on(t.orgId),
    check(
      "org_create_attempts_org_id_v7",
      sql`uuid_extract_version(${t.orgId}) = 7`,
    ),
    check(
      "org_create_attempts_hash_length",
      sql`octet_length(${t.keyHash}) = 32 AND octet_length(${t.requestHash}) = 32`,
    ),
    check(
      "org_create_attempts_slug_shape",
      sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'`,
    ),
    check(
      "org_create_attempts_state",
      sql`${t.state} IN ('pending', 'committed', 'refused')`,
    ),
    check(
      "org_create_attempts_settled",
      sql`(${t.state} = 'pending') = (${t.settledAt} IS NULL) AND ${t.settledAt} >= ${t.createdAt}`,
    ),
  ],
);

/**
 * An organisation's roles (P5-05, ADR 0066): the 12 default bundles
 * (11 before P6-06's viewer, ADR 0077)
 * copied at bootstrap (system_key names the bundle), the virtual `owner`
 * row (system_key 'owner', no role_permissions rows: its keys are the
 * code's ROLES.owner, immutable) and custom roles (system_key NULL).
 * Tenant table of resource org.role; archived rows keep their key free
 * (the open-key unique is partial). (org_id, id) is unique so a
 * membership's composite FK can never name another org's role. Both
 * timestamps come from the API's Clock.
 */
export const roles = bricx.table(
  "roles",
  {
    /** A UUIDv7 the API makes. */
    id: id(),
    /** P6-02 (ADR 0072; P5-05 Also line): the organisation must exist. */
    orgId: orgId().references(() => organizations.id),
    /** 1-64 of [a-z0-9_], starting with a letter; unique per org while open. */
    key: text("key").notNull(),
    /** 1-100 characters. */
    name: text("name").notNull(),
    /** The default bundle this row was copied from (ROLE_IDS), or NULL. */
    systemKey: text("system_key"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    /** Set once by an archive; never cleared. */
    archivedAt: timestamptz("archived_at"),
  },
  (t) => [
    unique("roles_org_id").on(t.orgId, t.id),
    uniqueIndex("roles_open_key")
      .on(t.orgId, t.key)
      .where(sql`${t.archivedAt} IS NULL`),
    check("roles_id_v7", sql`uuid_extract_version(${t.id}) = 7`),
    check("roles_key", sql`${t.key} ~ '^[a-z][a-z0-9_]{0,63}$'`),
    check("roles_name_length", sql`char_length(${t.name}) BETWEEN 1 AND 100`),
    // ROLE_IDS from @bricx/permissions, written out (test/grants.int.test.ts
    // keeps the two equal). P6-06 (ADR 0077) adds viewer; migration 0013
    // swaps the constraint (expand: the new one NOT VALID, VALIDATE, then
    // drop the old one under this name's predecessor).
    check(
      "roles_system_key_v2",
      sql`${t.systemKey} IN ('owner', 'project_owner', 'project_manager', 'quantity_surveyor', 'site_engineer', 'foreman', 'storekeeper', 'accountant', 'client', 'consultant', 'subcontractor', 'auditor', 'viewer')`,
    ),
    check("roles_updated", sql`${t.updatedAt} >= ${t.createdAt}`),
    check("roles_archived", sql`${t.archivedAt} >= ${t.createdAt}`),
  ],
);

/**
 * A role's catalogue keys (P5-05, ADR 0066): one open row per
 * (role, key); a revoke sets revoked_at and a later grant inserts a new
 * row, so the history stays. Tenant table of resource org.role.
 */
export const rolePermissions = bricx.table(
  "role_permissions",
  {
    id: id(),
    orgId: orgId(),
    roleId: uuid("role_id").notNull(),
    /** A catalogue key module.resource.action.scope (parseCatalogueKey). */
    permission: text("permission").notNull(),
    grantedAt: timestamptz("granted_at").notNull(),
    revokedAt: timestamptz("revoked_at"),
  },
  (t) => [
    foreignKey({
      name: "role_permissions_role_fk",
      columns: [t.orgId, t.roleId],
      foreignColumns: [roles.orgId, roles.id],
    }),
    uniqueIndex("role_permissions_open")
      .on(t.roleId, t.permission)
      .where(sql`${t.revokedAt} IS NULL`),
    check("role_permissions_id_v7", sql`uuid_extract_version(${t.id}) = 7`),
    check(
      "role_permissions_permission",
      sql`${t.permission} ~ '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*\\.(org|project|site|own)$' AND char_length(${t.permission}) <= 72`,
    ),
    check("role_permissions_revoked", sql`${t.revokedAt} >= ${t.grantedAt}`),
  ],
);

/**
 * Organisation memberships (P5-05, phase ruling D7, ADR 0066): one open
 * row per (org, user) with the user's org role; a removal sets removed_at
 * (soft: no DELETE under FORCE) and revokes the user's sessions in that
 * org in the same transaction. Tenant table of resource org.member, plus
 * an own-row SELECT (enableOwnRowPolicies, update: false) so the guard's
 * membership lookup and GET /v1/me/memberships read the user's rows in
 * any org. The composite FK keeps the role in the same org.
 */
export const memberships = bricx.table(
  "memberships",
  {
    id: id(),
    /** P6-02 (ADR 0072; P5-05 Also line): the organisation must exist. */
    orgId: orgId().references(() => organizations.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    roleId: uuid("role_id").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    /** Set once by a removal; never cleared. */
    removedAt: timestamptz("removed_at"),
    /**
     * P6-06b (ADR 0084): a suspended membership stays open (its role and
     * the unique index stand) but is not active; reactivation clears the
     * three columns together.
     */
    suspendedAt: timestamptz("suspended_at"),
    suspendedBy: uuid("suspended_by").references(() => users.id),
    /** 1..200 characters; never logged (owner condition C8). */
    suspendReason: text("suspend_reason"),
    /** A temporary membership ends here; NULL is permanent. */
    expiresAt: timestamptz("expires_at"),
    /** Set by the worker when it records the expiry; cleared by a renewal. */
    expiredAt: timestamptz("expired_at"),
    /** When the memberships.expiring notice was written; cleared by a renewal. */
    expiryNotifiedAt: timestamptz("expiry_notified_at"),
    /** Fixed at creation (memberships_guard): an external member is narrowed in buildAccess. */
    isExternal: boolean("is_external").notNull().default(false),
  },
  (t) => [
    foreignKey({
      name: "memberships_role_fk",
      columns: [t.orgId, t.roleId],
      foreignColumns: [roles.orgId, roles.id],
    }),
    uniqueIndex("memberships_open")
      .on(t.orgId, t.userId)
      .where(sql`${t.removedAt} IS NULL`),
    check("memberships_id_v7", sql`uuid_extract_version(${t.id}) = 7`),
    check("memberships_removed", sql`${t.removedAt} >= ${t.createdAt}`),
    check(
      "memberships_suspended",
      sql`(${t.suspendedAt} IS NULL) = (${t.suspendedBy} IS NULL) AND (${t.suspendedAt} IS NULL) = (${t.suspendReason} IS NULL) AND (${t.suspendReason} IS NULL OR char_length(${t.suspendReason}) BETWEEN 1 AND 200)`,
    ),
    check(
      "memberships_expires",
      sql`${t.expiresAt} IS NULL OR ${t.expiresAt} > ${t.createdAt}`,
    ),
    check(
      "memberships_expired",
      sql`${t.expiredAt} IS NULL OR (${t.expiresAt} IS NOT NULL AND ${t.expiredAt} >= ${t.expiresAt})`,
    ),
    index("memberships_due")
      .on(t.expiresAt)
      .where(
        sql`${t.removedAt} IS NULL AND ${t.expiredAt} IS NULL AND ${t.expiresAt} IS NOT NULL`,
      ),
    index("memberships_suspended_open")
      .on(t.orgId)
      .where(sql`${t.removedAt} IS NULL AND ${t.suspendedAt} IS NOT NULL`),
  ],
);

/**
 * Project memberships (P5-05, ADR 0066): one open row per (org, project,
 * user) with a project role and per-member overrides, a JSON object
 * {"add": [keys], "remove": [keys]} of at most 4 KiB (the keys are
 * validated by @bricx/permissions' validateOverrides before any write).
 * Tenant table of resource project.member (project level), plus an
 * own-row SELECT: a user's project rows are what DbGrantsSource reads to
 * build the project list, so they cannot wait for it. P6-05 (ADR 0075
 * D10, D11): (org_id, project_id) references projects; the migration
 * validates it in full, so an orphan row stops it. UNIQUE (org_id, id,
 * project_id, user_id) is the target of a site assignment's composite FK.
 */
export const projectMemberships = bricx.table(
  "project_memberships",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    roleId: uuid("role_id").notNull(),
    overrides: jsonb("overrides")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamptz("created_at").notNull(),
    removedAt: timestamptz("removed_at"),
    /** P6-06b (ADR 0084): as on memberships, for this project only. */
    suspendedAt: timestamptz("suspended_at"),
    suspendedBy: uuid("suspended_by").references(() => users.id),
    suspendReason: text("suspend_reason"),
    expiresAt: timestamptz("expires_at"),
    expiredAt: timestamptz("expired_at"),
    expiryNotifiedAt: timestamptz("expiry_notified_at"),
  },
  (t) => [
    foreignKey({
      name: "project_memberships_role_fk",
      columns: [t.orgId, t.roleId],
      foreignColumns: [roles.orgId, roles.id],
    }),
    foreignKey({
      name: "project_memberships_project_fk",
      columns: [t.orgId, t.projectId],
      foreignColumns: [projects.orgId, projects.id],
    }),
    unique("project_memberships_assignment_target").on(
      t.orgId,
      t.id,
      t.projectId,
      t.userId,
    ),
    uniqueIndex("project_memberships_open")
      .on(t.orgId, t.projectId, t.userId)
      .where(sql`${t.removedAt} IS NULL`),
    check("project_memberships_id_v7", sql`uuid_extract_version(${t.id}) = 7`),
    check(
      "project_memberships_overrides",
      sql`jsonb_typeof(${t.overrides}) = 'object' AND octet_length(${t.overrides}::text) <= 4096 AND (${t.overrides} - 'add' - 'remove') = '{}'::jsonb AND (NOT ${t.overrides} ? 'add' OR jsonb_typeof(${t.overrides} -> 'add') = 'array') AND (NOT ${t.overrides} ? 'remove' OR jsonb_typeof(${t.overrides} -> 'remove') = 'array')`,
    ),
    check("project_memberships_removed", sql`${t.removedAt} >= ${t.createdAt}`),
    check(
      "project_memberships_suspended",
      sql`(${t.suspendedAt} IS NULL) = (${t.suspendedBy} IS NULL) AND (${t.suspendedAt} IS NULL) = (${t.suspendReason} IS NULL) AND (${t.suspendReason} IS NULL OR char_length(${t.suspendReason}) BETWEEN 1 AND 200)`,
    ),
    check(
      "project_memberships_expires",
      sql`${t.expiresAt} IS NULL OR ${t.expiresAt} > ${t.createdAt}`,
    ),
    check(
      "project_memberships_expired",
      sql`${t.expiredAt} IS NULL OR (${t.expiresAt} IS NOT NULL AND ${t.expiredAt} >= ${t.expiresAt})`,
    ),
    index("project_memberships_due")
      .on(t.expiresAt)
      .where(
        sql`${t.removedAt} IS NULL AND ${t.expiredAt} IS NULL AND ${t.expiresAt} IS NOT NULL`,
      ),
    index("project_memberships_user_open")
      .on(t.orgId, t.userId)
      .where(sql`${t.removedAt} IS NULL`),
  ],
);

/**
 * Temporary elevations (P5-06, ADR 0067): one catalogue key granted to one
 * user for a bounded window, by someone else (granted_by <> user_id, the
 * requester ≠ approver shape), with a reason. scope_id names the project
 * for a project- or site-level key and is NULL for an org-level one.
 * P6-05 (ADR 0075, amending ADR 0067; owner condition C9): site_id names
 * the site of a site key; access_grants_scope holds the combinations (a
 * site key: scope_id and site_id; a project key: scope_id, no site_id; an
 * org or own key: neither), and both carry org_id into their FKs (the
 * site must be in the grant's project). Active at t:
 * starts_at <= t < expires_at AND revoked_at IS NULL (DbGrantsSource reads
 * it with the injected Clock). Ended once: a revoke sets revoked_at and
 * revoked_by; the expiry job sets expired_at (never both). The window is
 * 60 s to 30 d (ACCESS_GRANT_MAX_SECONDS caps it lower). Tenant table of
 * resource org.access_grant, plus an own-row SELECT (a user reads their
 * own grants in any org) and an owner-side SELECT for app.mfa_state() v2
 * and app.access_grants_due() (OWNER_READ_TABLES; guard allowlist SELECT
 * only). Not synced until P8-02. Timestamps come from the API's Clock;
 * expired_at from the database clock.
 */
export const accessGrants = bricx.table(
  "access_grants",
  {
    id: id(),
    orgId: orgId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** A catalogue key module.resource.action.scope (parseCatalogueKey). */
    permission: text("permission").notNull(),
    scopeId: uuid("scope_id"),
    /** The site of a site key (P6-05); NULL otherwise. */
    siteId: uuid("site_id"),
    /** 1-500 characters; audited, never logged. */
    reason: text("reason").notNull(),
    grantedBy: uuid("granted_by")
      .notNull()
      .references(() => users.id),
    startsAt: timestamptz("starts_at").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    revokedAt: timestamptz("revoked_at"),
    revokedBy: uuid("revoked_by").references(() => users.id),
    expiredAt: timestamptz("expired_at"),
    createdAt: timestamptz("created_at").notNull(),
  },
  (t) => [
    // The per-user cap and the ability read: open rows of (org, user).
    index("access_grants_user_open")
      .on(t.orgId, t.userId)
      .where(sql`${t.revokedAt} IS NULL AND ${t.expiredAt} IS NULL`),
    // The sweep: open rows by expiry.
    index("access_grants_due")
      .on(t.expiresAt)
      .where(sql`${t.revokedAt} IS NULL AND ${t.expiredAt} IS NULL`),
    foreignKey({
      name: "access_grants_project_fk",
      columns: [t.orgId, t.scopeId],
      foreignColumns: [projects.orgId, projects.id],
    }),
    foreignKey({
      name: "access_grants_site_fk",
      columns: [t.orgId, t.scopeId, t.siteId],
      foreignColumns: [sites.orgId, sites.projectId, sites.id],
    }),
    check(
      "access_grants_scope",
      sql`CASE WHEN ${t.permission} LIKE '%.site' THEN ${t.scopeId} IS NOT NULL AND ${t.siteId} IS NOT NULL WHEN ${t.permission} LIKE '%.project' THEN ${t.scopeId} IS NOT NULL AND ${t.siteId} IS NULL ELSE ${t.scopeId} IS NULL AND ${t.siteId} IS NULL END`,
    ),
    check("access_grants_id_v7", sql`uuid_extract_version(${t.id}) = 7`),
    check(
      "access_grants_permission",
      sql`${t.permission} ~ '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*\\.(org|project|site|own)$' AND char_length(${t.permission}) <= 72`,
    ),
    check(
      "access_grants_reason_length",
      sql`char_length(${t.reason}) BETWEEN 1 AND 500`,
    ),
    check("access_grants_not_self", sql`${t.grantedBy} <> ${t.userId}`),
    check(
      "access_grants_window",
      sql`${t.startsAt} < ${t.expiresAt} AND ${t.expiresAt} - ${t.startsAt} BETWEEN interval '60 seconds' AND interval '30 days'`,
    ),
    check(
      "access_grants_revoked",
      sql`(${t.revokedAt} IS NULL) = (${t.revokedBy} IS NULL) AND ${t.revokedAt} >= ${t.createdAt}`,
    ),
    check("access_grants_expired", sql`${t.expiredAt} >= ${t.expiresAt}`),
    check(
      "access_grants_one_end",
      sql`${t.revokedAt} IS NULL OR ${t.expiredAt} IS NULL`,
    ),
  ],
);

/**
 * The segregation-of-duties history (P5-07, ADR 0068; owner D-A and
 * condition 2): one row per action taken on a record chain. chain_id is
 * the originating record (ADR 0048); record_type and action are the
 * catalogue resource and action (finance.payment, request); actor_id is
 * always the requesting user, never an elevation's granter; project_id is
 * the record's scope. Written by @bricx/db/sod's recordSodAction() in the
 * action's own transaction; checkSod reads it. A system tenant table (no
 * catalogue resource): bricx_app SELECT and INSERT in its org, append-only
 * for every role, and the BEFORE INSERT trigger bricx.sod_conflict()
 * generated from SOD_RULES refuses a conflicting row whoever inserts it.
 * Not synced. created_at comes from the API's Clock.
 */
export const sodActions = bricx.table(
  "sod_actions",
  {
    id: id(),
    orgId: orgId(),
    chainId: uuid("chain_id").notNull(),
    recordId: uuid("record_id").notNull(),
    recordType: text("record_type").notNull(),
    action: text("action").notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    projectId: uuid("project_id"),
    createdAt: timestamptz("created_at").notNull(),
  },
  (t) => [
    // The chain's history, oldest first (by id: UUIDv7).
    index("sod_actions_chain").on(t.orgId, t.chainId, t.id),
    check("sod_actions_id_v7", sql`uuid_extract_version(${t.id}) = 7`),
    check(
      "sod_actions_record_type",
      sql`${t.recordType} ~ '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$' AND char_length(${t.recordType}) <= 64`,
    ),
    check(
      "sod_actions_action",
      sql`${t.action} ~ '^[a-z][a-z0-9_]*$' AND char_length(${t.action}) <= 64`,
    ),
  ],
);

/**
 * Region configuration (P6-03, ADR 0073): one row per layer, org then
 * project, one nullable typed column per field; NULL inherits from the
 * layer below (@bricx/domain/region-config resolves them). The org row
 * (project_id NULL) never holds currency, language, timezone or units:
 * the organisation's own columns are the one source (D8,
 * region_configs_org_columns). A project row never holds the session idle
 * timeout (D10, region_configs_project_idle). One row per (org, project),
 * the org row included (NULLS NOT DISTINCT). P6-05 (ADR 0075 D8, D10,
 * D11; owner condition C1): (org_id, project_id) references projects, and
 * a project row never holds currency, reporting currency or timezone (the
 * project's own columns are the one source, region_configs_project_fields).
 * Codes are checked
 * against ISO 4217, tzdb and the supported locales by the API; the CHECKs
 * hold their shapes and bounds (the backstop, owner condition C3). Tenant
 * table of resource org.region_config; bricx_app may UPDATE only the
 * field columns and updated_at (restrictTenantUpdate), and nobody deletes
 * (no DELETE policy under FORCE): a field goes back to NULL instead. Not
 * synced until P8-02. Timestamps come from the API's Clock.
 */
export const regionConfigs = bricx.table(
  "region_configs",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    /** NULL for the org row; the project's id otherwise. */
    projectId: uuid("project_id"),
    /** ISO 4217 (project rows only). */
    currency: text("currency"),
    /** ISO 4217. */
    reportingCurrency: text("reporting_currency"),
    /** A supported BCP 47 locale (project rows only). */
    language: text("language"),
    /** A tzdb zone name (project rows only). */
    timezone: text("timezone"),
    /** A BCP 47 tag dates and numbers are formatted with (D3). */
    formatLocale: text("format_locale"),
    /** metric or us_customary (project rows only). */
    units: text("units"),
    /** An opaque reference until P21. */
    taxProfileId: text("tax_profile_id"),
    /** Adapter ids, sorted, no duplicates, at most 16 (D12; P6-04 checks them). */
    paymentAdapters: text("payment_adapters").array(),
    /** An adapter id (P6-04 checks it). */
    accountingAdapter: text("accounting_adapter"),
    /** An opaque reference until P15. */
    rateLibrary: text("rate_library"),
    /** 60 to 43 200 (the realm's 12 h), org row only (D6, C2). */
    sessionIdleSeconds: integer("session_idle_seconds"),
    /** P6-06 (ADR 0077, D10): 1 to 168 hours, org row only. */
    invitationTtlHours: integer("invitation_ttl_hours"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (t) => [
    unique("region_configs_layer").on(t.orgId, t.projectId).nullsNotDistinct(),
    check("region_configs_id_v7", sql`uuid_extract_version(${t.id}) = 7`),
    check(
      "region_configs_org_columns",
      sql`${t.projectId} IS NOT NULL OR (${t.currency} IS NULL AND ${t.language} IS NULL AND ${t.timezone} IS NULL AND ${t.units} IS NULL)`,
    ),
    foreignKey({
      name: "region_configs_project_fk",
      columns: [t.orgId, t.projectId],
      foreignColumns: [projects.orgId, projects.id],
    }),
    check(
      "region_configs_project_fields",
      sql`${t.projectId} IS NULL OR (${t.currency} IS NULL AND ${t.reportingCurrency} IS NULL AND ${t.timezone} IS NULL)`,
    ),
    check(
      "region_configs_project_idle",
      sql`${t.projectId} IS NULL OR ${t.sessionIdleSeconds} IS NULL`,
    ),
    check("region_configs_currency", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      "region_configs_reporting_currency",
      sql`${t.reportingCurrency} ~ '^[A-Z]{3}$'`,
    ),
    check(
      "region_configs_language",
      sql`${t.language} ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$'`,
    ),
    check(
      "region_configs_timezone",
      sql`${t.timezone} ~ '^[A-Za-z0-9_+/-]{1,64}$'`,
    ),
    check(
      "region_configs_format_locale",
      sql`${t.formatLocale} ~ '^[A-Za-z0-9]{1,8}(-[A-Za-z0-9]{1,8})*$' AND char_length(${t.formatLocale}) <= 35`,
    ),
    check(
      "region_configs_units",
      sql`${t.units} IN ('metric', 'us_customary')`,
    ),
    check(
      "region_configs_tax_profile_id",
      sql`${t.taxProfileId} ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'`,
    ),
    check(
      "region_configs_payment_adapters",
      sql`cardinality(${t.paymentAdapters}) <= 16 AND (cardinality(${t.paymentAdapters}) = 0 OR array_ndims(${t.paymentAdapters}) = 1) AND array_position(${t.paymentAdapters}, NULL) IS NULL AND array_to_string(${t.paymentAdapters}, ',') ~ '^([a-z][a-z0-9_]{1,62}(,[a-z][a-z0-9_]{1,62})*)?$'`,
    ),
    check(
      "region_configs_accounting_adapter",
      sql`${t.accountingAdapter} ~ '^[a-z][a-z0-9_]{1,62}$'`,
    ),
    check(
      "region_configs_rate_library",
      sql`${t.rateLibrary} ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'`,
    ),
    check(
      "region_configs_session_idle_seconds",
      sql`${t.sessionIdleSeconds} BETWEEN 60 AND 43200`,
    ),
    check(
      "region_configs_invitation_ttl_hours",
      // NULL on every row unless the org row sets it (a NULL CHECK passes,
      // but NULL AND false is false: the IS NULL arm keeps project rows).
      sql`${t.invitationTtlHours} IS NULL OR (${t.invitationTtlHours} BETWEEN 1 AND 168 AND ${t.projectId} IS NULL)`,
    ),
    check("region_configs_updated", sql`${t.updatedAt} >= ${t.createdAt}`),
  ],
);

/**
 * Projects (P6-05, ADR 0075): tenant table of resource project.project
 * (its project column is id). code is unique per org regardless of case
 * (C7); currency, reporting_currency and timezone are the project layer
 * of the region configuration (D8, C1) and change only while draft;
 * contract_value_minor is minor units of contract_value_currency, both or
 * neither (D9, C8). status follows @bricx/domain's project machine (C3);
 * archived_at is set exactly when archived. The trigger
 * bricx.projects_guard (P6004) holds what a CHECK cannot: the currency
 * lock, an archived project is final, and id, org_id, created_by and
 * created_at never change. bricx_app may UPDATE only PROJECT_APP_COLUMNS.
 * Not published until P8-02. Timestamps come from the API's Clock.
 */
export const projects = bricx.table(
  "projects",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    clientName: text("client_name"),
    status: text("status").notNull().default("draft"),
    currency: text("currency").notNull(),
    reportingCurrency: text("reporting_currency").notNull(),
    timezone: text("timezone").notNull(),
    startDate: date("start_date", { mode: "string" }),
    endDate: date("end_date", { mode: "string" }),
    contractValueMinor: bigint("contract_value_minor", { mode: "bigint" }),
    contractValueCurrency: text("contract_value_currency"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    archivedAt: timestamptz("archived_at"),
  },
  (t) => [
    unique("projects_org_id").on(t.orgId, t.id),
    uniqueIndex("projects_code").on(t.orgId, sql`lower(${t.code})`),
    check("projects_id_v7", sql`uuid_extract_version(${t.id}) = 7`),
    check(
      "projects_code_format",
      sql`${t.code} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'`,
    ),
    check("projects_name", sql`char_length(${t.name}) BETWEEN 1 AND 200`),
    check(
      "projects_client_name",
      sql`char_length(${t.clientName}) BETWEEN 1 AND 200`,
    ),
    check(
      "projects_status",
      sql`${t.status} IN ('draft', 'active', 'on_hold', 'completed', 'archived')`,
    ),
    check("projects_currency", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      "projects_reporting_currency",
      sql`${t.reportingCurrency} ~ '^[A-Z]{3}$'`,
    ),
    check("projects_timezone", sql`${t.timezone} ~ '^[A-Za-z0-9_+/-]{1,64}$'`),
    check(
      "projects_contract_value",
      sql`(${t.contractValueMinor} IS NULL) = (${t.contractValueCurrency} IS NULL) AND ${t.contractValueMinor} >= 0 AND ${t.contractValueCurrency} ~ '^[A-Z]{3}$'`,
    ),
    check("projects_dates", sql`${t.startDate} <= ${t.endDate}`),
    check(
      "projects_archived",
      sql`(${t.status} = 'archived') = (${t.archivedAt} IS NOT NULL)`,
    ),
    check("projects_updated", sql`${t.updatedAt} >= ${t.createdAt}`),
  ],
);

/**
 * Sites (P6-05, ADR 0075 D17; owner condition C6): tenant table of
 * resource project.site (its site column is id). geom is a geography
 * polygon (SRID 4326, 2-D, valid, outer ring counter-clockwise as the API
 * stores it, at most 1 000 km²) or NULL; GiST-indexed for point-in-site
 * queries. (org_id, project_id) references projects; UNIQUE (org_id,
 * project_id, id) is the target of the site FKs, so a site never crosses
 * its project or org. Archived once (bricx.sites_guard, P6005: an
 * archived site is final; id, org_id, project_id, created_by and
 * created_at never change). An extra SELECT policy lets a user read the
 * sites they are assigned to or an open elevation names, whatever their
 * project list (DbGrantsSource, C4). Not published until P8-02.
 */
export const sites = bricx.table(
  "sites",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id").notNull(),
    name: text("name").notNull(),
    geom: geography("geom"),
    address: text("address"),
    geofenceRadiusM: integer("geofence_radius_m").notNull().default(0),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    archivedAt: timestamptz("archived_at"),
  },
  (t) => [
    foreignKey({
      name: "sites_project_fk",
      columns: [t.orgId, t.projectId],
      foreignColumns: [projects.orgId, projects.id],
    }),
    unique("sites_org_project_id").on(t.orgId, t.projectId, t.id),
    index("sites_geom_gist").using("gist", t.geom),
    check("sites_id_v7", sql`uuid_extract_version(${t.id}) = 7`),
    check("sites_name", sql`char_length(${t.name}) BETWEEN 1 AND 200`),
    check("sites_address", sql`char_length(${t.address}) BETWEEN 1 AND 500`),
    check(
      "sites_geofence_radius",
      sql`${t.geofenceRadiusM} BETWEEN 0 AND 10000`,
    ),
    check(
      "sites_geom_shape",
      sql`extensions.ST_SRID(${t.geom}) = 4326 AND extensions.GeometryType(${t.geom}::extensions.geometry) = 'POLYGON' AND extensions.ST_NDims(${t.geom}::extensions.geometry) = 2`,
    ),
    check(
      "sites_geom_valid",
      sql`extensions.ST_IsValid(${t.geom}::extensions.geometry) AND extensions.ST_IsPolygonCCW(${t.geom}::extensions.geometry)`,
    ),
    check("sites_geom_area", sql`extensions.ST_Area(${t.geom}) <= 1e9`),
    check("sites_updated", sql`${t.updatedAt} >= ${t.createdAt}`),
  ],
);

/**
 * Site assignment (P6-05, ADR 0075 D15; owner condition C4): the sites a
 * project membership's site-scope keys hold on. One open row per
 * (membership, site); ended by removed_at, never deleted. The composite
 * FKs keep the site in the membership's project and org, and user_id
 * equal to the membership's. Tenant table of resource project.member,
 * plus an own-row SELECT (DbGrantsSource reads the user's rows before the
 * project list exists). bricx_app may UPDATE removed_at only. Not
 * published. created_at comes from the API's Clock.
 */
export const projectMembershipSites = bricx.table(
  "project_membership_sites",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id").notNull(),
    projectMembershipId: uuid("project_membership_id").notNull(),
    userId: uuid("user_id").notNull(),
    siteId: uuid("site_id").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    removedAt: timestamptz("removed_at"),
  },
  (t) => [
    foreignKey({
      name: "project_membership_sites_site_fk",
      columns: [t.orgId, t.projectId, t.siteId],
      foreignColumns: [sites.orgId, sites.projectId, sites.id],
    }),
    foreignKey({
      name: "project_membership_sites_membership_fk",
      columns: [t.orgId, t.projectMembershipId, t.projectId, t.userId],
      foreignColumns: [
        projectMemberships.orgId,
        projectMemberships.id,
        projectMemberships.projectId,
        projectMemberships.userId,
      ],
    }),
    uniqueIndex("project_membership_sites_open")
      .on(t.projectMembershipId, t.siteId)
      .where(sql`${t.removedAt} IS NULL`),
    index("project_membership_sites_user")
      .on(t.orgId, t.userId)
      .where(sql`${t.removedAt} IS NULL`),
    check(
      "project_membership_sites_id_v7",
      sql`uuid_extract_version(${t.id}) = 7`,
    ),
    check(
      "project_membership_sites_removed",
      sql`${t.removedAt} >= ${t.createdAt}`,
    ),
  ],
);

/**
 * Invitations (P6-06, ADR 0077): an e-mail invitation into an
 * organisation, optionally onto one of its projects, with the role the
 * invitee gets on accept. The token's secret is never stored: token_hash
 * is SHA-256 of it (32 bytes), set by the worker when it sends (NULL
 * until then, so an unsent invitation cannot be accepted). One pending
 * invitation per (org, project, e-mail) (invitations_pending_email, the
 * duplicate guard's backstop). Statuses: pending, then once accepted,
 * expired or revoked (trigger invitations_guard: the core columns never
 * change, a terminal row never changes again, email_normalised is nulled
 * by the accept alone, C6). Tenant table of resource org.member, plus an
 * owner-side SELECT for app.invitation_by_token_hash() and
 * app.invitations_due() (OWNER_READ_TABLES); bricx_app may UPDATE the
 * lifecycle columns only. Not synced. Timestamps come from the API's (or
 * the worker's) Clock.
 */
export const invitations = bricx.table(
  "invitations",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    /** NULL for an org invitation; the project's id otherwise. */
    projectId: uuid("project_id"),
    /** NFKC, trimmed, lowercased (@bricx/validation/email); NULL once accepted. */
    emailNormalised: text("email_normalised"),
    /** The org role the invitee gets. */
    roleId: uuid("role_id").notNull(),
    /** The project role (project invitations only). */
    projectRoleId: uuid("project_role_id"),
    /** SHA-256 of the token's secret; NULL until the worker first sends. */
    tokenHash: bytea("token_hash"),
    /** Bumped by each (re)send; the send job carries the value it was made for. */
    sendSeq: integer("send_seq").notNull().default(1),
    resendCount: integer("resend_count").notNull().default(0),
    activationCount: integer("activation_count").notNull().default(0),
    lastSentAt: timestamptz("last_sent_at"),
    expiresAt: timestamptz("expires_at").notNull(),
    status: text("status").notNull().default("pending"),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.id),
    acceptedBy: uuid("accepted_by").references(() => users.id),
    acceptedAt: timestamptz("accepted_at"),
    /** NULL with a revoked_at: revoked by the system (a cascade). */
    revokedBy: uuid("revoked_by").references(() => users.id),
    revokedAt: timestamptz("revoked_at"),
    revokeReason: text("revoke_reason"),
    /**
     * P6-06b (ADR 0084): what the accepted membership carries. Both are
     * fixed at creation (invitations_guard). membership_expires_at is an
     * absolute instant: an accept after it is refused (owner addition A1).
     */
    isExternal: boolean("is_external").notNull().default(false),
    membershipExpiresAt: timestamptz("membership_expires_at"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "invitations_role_fk",
      columns: [t.orgId, t.roleId],
      foreignColumns: [roles.orgId, roles.id],
    }),
    foreignKey({
      name: "invitations_project_role_fk",
      columns: [t.orgId, t.projectRoleId],
      foreignColumns: [roles.orgId, roles.id],
    }),
    foreignKey({
      name: "invitations_project_fk",
      columns: [t.orgId, t.projectId],
      foreignColumns: [projects.orgId, projects.id],
    }),
    uniqueIndex("invitations_pending_email")
      .on(
        t.orgId,
        sql`COALESCE(${t.projectId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        t.emailNormalised,
      )
      .where(sql`${t.status} = 'pending'`),
    uniqueIndex("invitations_token_hash").on(t.tokenHash),
    index("invitations_list").on(t.orgId, t.id.desc()),
    index("invitations_due")
      .on(t.expiresAt)
      .where(sql`${t.status} = 'pending'`),
    index("invitations_inviter")
      .on(t.orgId, t.invitedBy)
      .where(sql`${t.status} = 'pending'`),
    index("invitations_project")
      .on(t.orgId, t.projectId)
      .where(sql`${t.status} = 'pending'`),
    check("invitations_id_v7", sql`uuid_extract_version(${t.id}) = 7`),
    check(
      "invitations_status",
      sql`${t.status} IN ('pending', 'accepted', 'expired', 'revoked')`,
    ),
    check(
      "invitations_email",
      sql`${t.emailNormalised} IS NULL OR (char_length(${t.emailNormalised}) BETWEEN 3 AND 254 AND ${t.emailNormalised} = lower(${t.emailNormalised}))`,
    ),
    check(
      "invitations_email_state",
      sql`(${t.status} = 'accepted') = (${t.emailNormalised} IS NULL)`,
    ),
    check(
      "invitations_project_role",
      sql`(${t.projectId} IS NULL) = (${t.projectRoleId} IS NULL)`,
    ),
    check(
      "invitations_token_hash",
      sql`${t.tokenHash} IS NULL OR octet_length(${t.tokenHash}) = 32`,
    ),
    check(
      "invitations_counts",
      sql`${t.sendSeq} BETWEEN 1 AND 1000 AND ${t.resendCount} BETWEEN 0 AND 100 AND ${t.activationCount} BETWEEN 0 AND 100`,
    ),
    check(
      "invitations_accepted",
      sql`(${t.status} = 'accepted') = (${t.acceptedAt} IS NOT NULL) AND (${t.acceptedAt} IS NULL) = (${t.acceptedBy} IS NULL)`,
    ),
    check(
      "invitations_revoked",
      sql`(${t.status} = 'revoked') = (${t.revokedAt} IS NOT NULL) AND (${t.revokedAt} IS NULL) = (${t.revokeReason} IS NULL) AND (${t.revokedBy} IS NULL OR ${t.revokedAt} IS NOT NULL)`,
    ),
    check(
      "invitations_revoke_reason_v2",
      sql`${t.revokeReason} IN ('manual', 'inviter_removed', 'inviter_lacks_rights', 'project_archived', 'org_archived', 'inviter_suspended')`,
    ),
    check(
      "invitations_external_project",
      sql`NOT ${t.isExternal} OR ${t.projectId} IS NOT NULL`,
    ),
    check(
      "invitations_membership_expires",
      sql`${t.membershipExpiresAt} IS NULL OR ${t.membershipExpiresAt} > ${t.createdAt}`,
    ),
    check("invitations_expires", sql`${t.expiresAt} > ${t.createdAt}`),
    check("invitations_updated", sql`${t.updatedAt} >= ${t.createdAt}`),
  ],
);

// new-module: tables (pnpm new-module adds an export above, P4-09)
