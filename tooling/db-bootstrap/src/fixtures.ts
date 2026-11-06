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
