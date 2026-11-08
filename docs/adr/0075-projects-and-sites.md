# 0075. Projects and sites: tables, status machine, site assignment, site elevations and PostGIS boundaries

- Status: Accepted
- Date: 2026-11-08
- Deciders: Mohamed Abass Jalloh
- Source: ROADMAP P6-05, the P6-03 Also line (ADR 0073) and the P6-04 consequences that touch projects (ADR 0074); P6 phase plan approved 2026-11-06 16:46Z (D1–D7, ruling R8); P6-05 task plan (D8–D18) approved 2026-11-08 02:51Z with owner conditions C1–C9; ADR 0067 (access grants), ADR 0072 (organisations), ADR 0073 (region configuration); CLAUDE.md rules 1, 3, 4, 7, 8, 11 and 12

## Context

Until P6-05 a project was only an id: project memberships (P5-05), project-scoped elevations (P5-06) and region-config project rows (P6-03) named a bare UUIDv7 that nothing checked. Site-level permission keys existed in the catalogue, but no site existed, so DbGrantsSource dropped them. This task creates the projects and their sites, holds every row that names a project or a site to a real one in the same organisation, and gives site keys a meaning.

## Decision

### D1–D7 (phase plan) and R8

The phase plan's decisions stand: `projects` and `sites` are tenant tables under FORCE RLS, ids UUIDv7, not synced before P8-02, `client_name` instead of a client organisation (P20), the area bound is 1 000 km² (R8), and this ADR amends ADR 0067 for site elevations (D16 below).

Creating a project makes nobody a member (C5). An org-scope holder of `project.project.read` (the owner, an accountant) sees it at once; anyone else is assigned through `POST /v1/projects/{projectId}/members`.

### D8, C1. A project's currency, reporting currency and timezone

`projects.currency`, `reporting_currency` and `timezone` are NOT NULL columns. Each takes the request's value, otherwise the organisation's effective value (`resolveRegionConfig()` over the org's columns and its region-config row). These three columns are the project layer for those fields: `/v1/region-config/effective?projectId=` reports them with source `project`.

- A region-config project row never holds them: the CHECK `region_configs_project_fields` (all three NULL), and the project PATCH DTO refuses them as unknown fields (422).
- All three are locked once the project leaves `draft` (C1): a change answers 409 `request.conflict`; the same value is no change and passes. `bricx.projects_guard` (SQLSTATE P6004) is the backstop.
- architect-reviewed 2026-11-08: the plan's "currency changes only in draft" marker, extended by C1 to reporting currency and timezone.

### D9, C8. The contract value

`contract_value_minor bigint` with `contract_value_currency`: both NULL or both set, the amount `>= 0` (CHECK). The API field `contractValue` is MoneySchema's `{ amount, currency }` (minor units as a string, a currency with a minor unit, signed 64-bit), never negative; its currency may differ from the project's.

It is answered, and may be written, only to callers holding `project.project.update` on that project (C8); everyone else reads `null`, and a write from them is 403. Audit events never hold an amount: an update names the changed field `contractValue` only. P9-01 Also: move this gate to a finance key.

### D10, D11. Foreign keys that hold the tenant, and orphan rows

Every foreign key carries `org_id`: `sites`, `project_memberships`, `region_configs` and `access_grants.scope_id` reference `projects (org_id, id)`; `access_grants (org_id, scope_id, site_id)` and `project_membership_sites (org_id, project_id, site_id)` reference `sites (org_id, project_id, id)`, so a site never crosses its project or organisation. The keys are added fully validated: no `NOT VALID`, no delete, no skip. An orphan row makes migration 0011 fail with 23503 naming the constraint; nothing is applied and every row stays (one integration test per table).

**Finding (corrects the plan's D11).** FORCE ROW LEVEL SECURITY binds the table owner, and Postgres validates a new foreign key with a query run as the owner. Under FORCE, the validating query sees no row (no `app.org_id` is set while migrating), so an orphan would pass unnoticed. Migration 0011 therefore wraps each foreign key added to an existing table in `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` and `... FORCE ROW LEVEL SECURITY`, inside the migration's one transaction. RLS stays enabled throughout, `bricx_app` never sees the window, and the migrator's RLS guard checks FORCE again after the migration. The orphan tests fail without this step.

Local databases holding bare-UUID project rows from P5 or P6-03 need `pnpm dev:reset`. No production database exists.

### D12, C2. Region-config project routes

An unknown project, another organisation's, or one outside the caller's projects answers 404 on `GET /v1/region-config/effective?projectId=`, `GET` and `PATCH /v1/region-config/projects/{id}` (C2). An archived project's PATCH is 409; a foreign key violation maps to 404, never 500. This replaces ADR 0073 D10 for projects (dated note there).

- architect-reviewed 2026-11-08: the plan's "GET keeps the org's values for an unknown project" marker, changed by C2 to 404.
- Changed P6-03 assertions (PR body): the region-config integration suite now creates real projects; the foreign-org test expects 404 on all three routes; the three currency/timezone project-row writes move to language, units and tax profile, and currency, reporting currency and timezone on a project row are 422; the unit suite's two project-row cases write language and units.

### D13. The P6-04 consequences

The adapter checks of ADR 0074 D9 run on real project rows (tested). Production's registry is empty, so a project adapter write answers 422 until real adapters arrive. Creating a project never touches adapters (P17-01 Also: capability matching against the project's currency and country).

### D14, C3. The status machine

`@bricx/domain/project-status`: draft → active | archived; active → on_hold | completed; on_hold → active | completed; completed → archived; archived is final, nothing reopens. `POST /v1/projects/{id}/status { to }`: a move to archived needs `project.project.archive`, any other move `project.project.update`; a refused move is 409. No catalogue key was added. An archived project is read-only: its PATCH and any site create, update or archive answer 409; reads work.

- architect-reviewed 2026-11-08: the machine as posted, accepted (C3).

### D15, C4. Sites and site assignment

A site is archived once, never deleted or un-archived (`bricx.sites_guard`, P6005). A project membership's `siteIds` (POST and PATCH; at most 100, unique, stored and answered sorted) must all be open sites of that project, otherwise 422 `unknown_site` at `siteIds` and nothing is written. They are rows of `project_membership_sites`, closed with `removed_at` when dropped, when the membership is unassigned and when the user leaves the organisation.

DbGrantsSource turns a membership's site-scope keys into site grants on exactly its assigned sites: empty `siteIds` means no site keys (C4); on an archived site only `read` keys stay. A membership POST or PATCH on an archived project is 409; removal still works.

### D16, C9. Site elevations (amends ADR 0067)

`access_grants` gains `site_id`. The CHECK `access_grants_scope`: a site key needs `scope_id` and `site_id`; a project key `scope_id` and no `site_id`; an org or own key neither. `POST /v1/access-grants` takes `siteId`: a site key without it, or a project or org key with it, is 422 at the field; the site must be an open site of the `scopeId` project (422 `unknown_site` at `siteId`). The row, the response and the audit event carry `siteId`. Unassigning the member ends their site elevations with the project's others (`endAccessGrantsOf` by `scope_id`).

Every reader of `access_grants` that changed, each with a test:
- DbGrantsSource: a site elevation is a site grant on its `site_id` (read keys only once the site is archived; a site the transaction cannot see counts as archived);
- the sweep and `expireAccessGrant()` (`@bricx/db/access-grants`): the expired grant and its audit `before`/`after` carry `siteId`;
- the worker's expiry job (apps/worker access suite): the site elevation expires like the others.

Changed P5 assertions (R8, PR body): `scopeOf("field.dailylog.read.site", project)` is refused at `siteId` (was `permission`); the grant response and the audit `after` carry `siteId`; project-membership responses and audit events carry `siteIds`; the access-grants module imports four modules (ProjectsModule added). Integration suites whose P5 setup or shape assertions changed because the new foreign keys and CHECKs hold: `access_grants` gains the `site_id` column and two foreign keys, and an org-scoped grant row needs an org-level key (a project key with no `scope_id` is now 23514); `project_memberships` gains `project_memberships_project_fk` and the unique `project_memberships_assignment_target`; the RLS suite seeds projects, sites and site assignments as foreign-key parents and expects `sites_assigned_select`; the grants-source, access-grants, memberships, worker access and module-template suites seed the projects their rows name, and the template suite proves a membership naming another org's project is refused by the foreign key (23503) instead of using one; the drizzle-kit migrate test names its generated tables `demo_sites`/`demo_zones`, since `bricx.sites` now exists.

### D16 (routes), C5. Projects and sites over HTTP

`/v1/projects` (POST, GET, GET/PATCH `:id`, POST `:id/status`) and `/v1/projects/{projectId}/sites` (POST, GET, GET/PATCH `:id`, POST `:id/archive`). Each `@Can` declares `{ anywhere: true }` (ADR 0068): the guard checks the action is held somewhere; the service checks the record, so a project or site the caller may not read is 404, the same body as an unknown id (C5), and one they read but may not change is 403. Reading a site checks `project.project.read` at the guard, because a site key may hold on no site (C4) and that answer is the service's 404. Lists are keyset-paged by id (UUIDv7), newest first, limit 1..100 (default 25), with `?status=` on projects. One audit event per write: `project.project.create`, `.update` (changed field names only), `.status` (before/after status); `project.site.create`, `.update`, `.archive`. Creates are `@Idempotent`.

Sites live in the projects module (`modules/projects/sites.*`), not a separate module: a site has no route outside its project, and the module exports one `ProjectsReader` (a project's state, a project's open sites) to memberships, access grants and region configuration through its public API (rule 13). (For architect review: the plan listed `modules/sites/*`.)

### D17, C6. Geometry and PostGIS

A site's `boundary` is a GeoJSON Polygon in `[lng, lat]` through `@bricx/validation`'s `GeoPolygonSchema`: bounded before any position is read (21 rings, 1 000 positions), every position finite, 2-D, longitude −180..180, latitude −90..90 (−0 stored as 0), rings closed with at least 4 positions, and orientation normalised (outer ring counter-clockwise, holes clockwise, RFC 7946 §3.1.6). A geography polygon's ring order decides which side is inside, so a clockwise ring would describe the rest of the globe; normalising makes clockwise and counter-clockwise input of the same polygon store identically (tested byte for byte). A ring with no area is refused.

The column is `geom extensions.geography` (a Drizzle `customType`, no package added), NULL allowed: a site may be recorded before its boundary is surveyed (for architect review). CHECKs: SRID 4326, `POLYGON`, two dimensions (`sites_geom_shape`); `ST_IsValid` and `ST_IsPolygonCCW` (`sites_geom_valid`); `ST_Area <= 1e9` m² (`sites_geom_area`). The API maps the first two to 422 `invalid_polygon` at `boundary` and the third to 422 `polygon_too_large`, never 500. A GiST index `sites_geom_gist` serves point-in-site queries (EXPLAIN test). `geofence_radius_m` is 0..10 000, `address` at most 500 characters.

**How PostGIS is provisioned (C6).** In every environment the extension exists before migrations run, in schema `extensions`, created by a superuser; the app role never runs `CREATE EXTENSION`.
- Dev: `infrastructure/docker/compose.yml` pins `postgis/postgis:18-3.6` by digest; `infrastructure/docker/postgres/init/01-bootstrap.sh` runs `CREATE EXTENSION postgis SCHEMA extensions` as the bootstrap superuser on first start; `tooling/db-bootstrap/src/checks.ts` asserts `postgis@extensions`.
- Testcontainers: `@bricx/db-bootstrap/stack` reads the same image from compose.yml and mounts the same init folder, so suites get the same extension in the same schema.
- Production (P13-01): the managed database's administrator creates the extension in schema `extensions` as part of provisioning, before the first migration, the same statement as dev. No migration creates an extension, and `tooling/db-bootstrap` checks that `bricx_app` is refused every DDL statement, `CREATE EXTENSION` and `CREATE TABLE extensions.*` included.
- A test proves `bricx_app` is refused `CREATE EXTENSION` and that PostGIS lives in `extensions`.

### D18, C7. Fields

`code` matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$`, unique per organisation regardless of case (`UNIQUE (org_id, lower(code))`), duplicate 409, editable. `name` 1..200, `client_name` 1..200 or NULL, dates are `date` with `start_date <= end_date` (422 at `endDate`).

### New issue codes

`invalid_polygon`, `polygon_too_large`, `unknown_site`, with en, fr and ar text (fr and ar machine-drafted, native review before production).

## Consequences

- `pnpm dev:reset` after merge (orphan rows and the new keys).
- `access_grants` changed shape; its immutability trigger now covers `site_id`.
- Also lines: P8-02 (publish projects and sites with stream scopes and a leak test, excluding `contract_*`), P9-01 (C8: move the contract-value gate to a finance key), P17-01 (adapter capabilities against the project's currency and country), P20 (link a real client organisation, replacing `client_name`).

## Alternatives rejected

- Keeping currency, reporting currency and timezone only in region-config project rows: two sources once projects have columns, and an organisation change could silently move a project's currency.
- Adding foreign keys `NOT VALID`, or deleting orphans: a silent change to data; the P6-03 Also line asked for a loud failure.
- Dropping FORCE RLS for the whole migration: the window would cover every statement, not only the validation.
- A separate assignment route for sites: a second write path for one membership.
- Accepting either ring orientation as stored: a clockwise outer ring is a different (complementary) geography.
- A geography column typed `geography(Polygon, 4326)`: a 3-D or other-shape input would fail with a type error instead of the CHECK's 23514, so the API could not answer 422 with a code.
