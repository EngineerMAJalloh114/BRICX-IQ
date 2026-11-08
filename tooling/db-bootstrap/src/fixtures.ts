// Shared test fixtures for the cell database (P6-02, ADR 0072; owner
// condition C4). Since migration 0009, roles.org_id and memberships.org_id
// reference bricx.organizations(id), so a suite that seeds roles or
// memberships for an organisation first seeds that organisation's row
// here. Fixtures only: a fixed, valid organisation (its slug derived from
// the id, so ids never collide), inserted by the caller's privileged
// connection (the test superuser, which RLS does not bind), idempotent.
// Nothing outside the test suites imports this file.

/** Something that runs SQL as the test superuser. */
export type FixtureQuery = (
  text: string,
  params?: unknown[],
) => Promise<unknown>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The fixture slug of `orgId`: "fixture-" and the id's last 12 hex digits. */
export const fixtureSlug = (orgId: string): string =>
  `fixture-${orgId.slice(-12)}`;

/**
 * Inserts the bricx.organizations row of `orgId` (a lower-case UUIDv7) if
 * it is missing: a valid organisation in af-south-1, created an hour ago.
 */
export async function seedOrganization(
  query: FixtureQuery,
  orgId: string,
): Promise<void> {
  if (!UUID.test(orgId)) throw new Error("seedOrganization: not a UUIDv7");
  await query(
    `INSERT INTO bricx.organizations
       (id, slug, legal_name, country, default_currency, default_language,
        timezone, units, data_region, created_at, updated_at)
     VALUES ($1, $2, 'Fixture organisation', 'SL', 'USD', 'en',
        'Africa/Freetown', 'metric', 'af-south-1',
        now() - interval '1 hour', now() - interval '1 hour')
     ON CONFLICT (id) DO NOTHING`,
    [orgId, fixtureSlug(orgId)],
  );
}

/** seedOrganization() for each id. */
export async function seedOrganizations(
  query: FixtureQuery,
  orgIds: Iterable<string>,
): Promise<void> {
  for (const orgId of orgIds) await seedOrganization(query, orgId);
}

/** The fixture projects' creator: a users row seeded with them. */
export const FIXTURE_PROJECT_CREATOR = "0199e1aa-0000-7000-8000-00000000c0de";

/** The fixture code of `projectId`: "FX-" and the id's last 12 hex digits. */
export const fixtureProjectCode = (projectId: string): string =>
  `FX-${projectId.slice(-12)}`;

/**
 * Inserts the bricx.projects row of `projectId` in `orgId` if it is
 * missing (P6-05, ADR 0075 D11): since migration 0011,
 * project_memberships.project_id, access_grants.scope_id and
 * region_configs.project_id reference projects (org_id, id), so a suite
 * that seeds those rows first seeds the project here. The organisation
 * and the fixture creator are seeded too. A draft project in USD, Africa/
 * Freetown, created an hour ago. A project id already used by another
 * organisation is refused by the primary key, as it should be.
 */
export async function seedProject(
  query: FixtureQuery,
  orgId: string,
  projectId: string,
): Promise<void> {
  if (!UUID.test(projectId)) throw new Error("seedProject: not a UUIDv7");
  await seedOrganization(query, orgId);
  await query(
    `INSERT INTO bricx.users (id, keycloak_sub, created_at, last_seen_at)
     VALUES ($1, 'fixture-project-creator', now() - interval '1 hour', now() - interval '1 hour')
     ON CONFLICT DO NOTHING`,
    [FIXTURE_PROJECT_CREATOR],
  );
  await query(
    `INSERT INTO bricx.projects
       (id, org_id, code, name, status, currency, reporting_currency,
        timezone, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'Fixture project', 'draft', 'USD', 'USD',
        'Africa/Freetown', $4, now() - interval '1 hour', now() - interval '1 hour')
     ON CONFLICT (id) DO NOTHING`,
    [projectId, orgId, fixtureProjectCode(projectId), FIXTURE_PROJECT_CREATOR],
  );
}

/** seedProject() for each id. */
export async function seedProjects(
  query: FixtureQuery,
  orgId: string,
  projectIds: Iterable<string>,
): Promise<void> {
  for (const projectId of projectIds)
    await seedProject(query, orgId, projectId);
}
