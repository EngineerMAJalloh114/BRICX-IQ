// The seed dataset (P6-05b, ADR 0076; binding decisions F, G, J1, K1;
// architect calls 1, 4 and 5): what `pnpm db:seed` writes into the local
// dev database, and nothing else.
// - Two organisations in two region cells (J1, a dev-only simplification:
//   one database stands in for both cells, so this is not two-cell
//   isolation evidence; ADR 0020, 0076): A in af-south-1 (Sierra Leone,
//   SLE, en, reporting USD) and B in eu-west-1 (France, EUR, fr,
//   reporting GHS).
// - In each: the twelve roles with the default bundles from
//   @bricx/permissions (the rows bootstrapOrganization() writes), one
//   user per role (K1) with a membership holding that role, one active
//   project created by the owner (A: Lagos, NGN; B: Nairobi, KES, language
//   ar, the RTL case), two sites with small counter-clockwise boundaries,
//   the project roles as project members, and the site engineer and the
//   foreman assigned to site 1.
// - Users are database rows only, with fake subjects seed-<org>-<role>: no
//   Keycloak account (P7-05 Also line) and no directory row (ADR 0076).
// - Every id is a committed UUIDv7 literal (F): `idOf` maps a dataset name
//   to it (ids.ts's seedId; the tests also pass deriveSeedId). Every
//   timestamp is the seed instant (G). Fake values only (requirement 4).
import { ROLE_IDS, ROLES, type RoleId } from "@bricx/permissions/roles";

/** The seed instant: 2026-01-01T00:00:00Z (G). */
export const SEED_INSTANT_MS = 1_767_225_600_000;
export const SEED_INSTANT = "2026-01-01T00:00:00.000Z";

/** A GeoJSON polygon, outer ring only, counter-clockwise (C6). */
export interface SeedPolygon {
  readonly type: "Polygon";
  readonly coordinates: readonly (readonly (readonly [number, number])[])[];
}

export interface SeedRole {
  readonly id: string;
  readonly key: RoleId;
  readonly permissions: readonly {
    readonly id: string;
    readonly permission: string;
  }[];
}

export interface SeedUser {
  readonly id: string;
  readonly sub: string;
  readonly role: RoleId;
  readonly membershipId: string;
}

export interface SeedProject {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly clientName: string;
  readonly status: "active";
  readonly currency: string;
  readonly reportingCurrency: string;
  readonly timezone: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly createdBy: string;
  readonly regionConfig: {
    readonly id: string;
    readonly language: string;
    readonly formatLocale: string;
  };
}

export interface SeedSite {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly boundary: SeedPolygon;
}

export interface SeedOrg {
  readonly key: "a" | "b";
  readonly id: string;
  readonly slug: string;
  readonly legalName: string;
  readonly country: string;
  readonly defaultCurrency: string;
  readonly defaultLanguage: string;
  readonly timezone: string;
  readonly units: "metric";
  readonly dataRegion: string;
  readonly regionConfig: {
    readonly id: string;
    readonly reportingCurrency: string;
    readonly formatLocale: string;
  };
  readonly roles: readonly SeedRole[];
  readonly users: readonly SeedUser[];
  readonly project: SeedProject;
  readonly sites: readonly SeedSite[];
  readonly projectMembers: readonly {
    readonly id: string;
    readonly userId: string;
    readonly roleId: string;
  }[];
  readonly siteAssignments: readonly {
    readonly id: string;
    readonly projectMembershipId: string;
    readonly userId: string;
    readonly siteId: string;
  }[];
}

export interface SeedDataset {
  readonly instant: string;
  readonly orgs: readonly SeedOrg[];
}

/** The roles that are members of their organisation's project. */
const PROJECT_ROLES: readonly RoleId[] = [
  "project_owner",
  "project_manager",
  "quantity_surveyor",
  "site_engineer",
  "foreman",
  "storekeeper",
  "client",
  "consultant",
  "subcontractor",
];

/** The roles assigned to site 1 (site-scope keys hold there). */
const SITE_ROLES: readonly RoleId[] = ["site_engineer", "foreman"];

/** A closed counter-clockwise rectangle from its west-south corner. */
function rectangle(
  west: number,
  south: number,
  east: number,
  north: number,
): SeedPolygon {
  return {
    type: "Polygon",
    coordinates: [
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ],
  };
}

interface OrgFacts {
  readonly key: "a" | "b";
  readonly slug: string;
  readonly legalName: string;
  readonly country: string;
  readonly defaultCurrency: string;
  readonly defaultLanguage: string;
  readonly timezone: string;
  readonly dataRegion: string;
  readonly reportingCurrency: string;
  readonly formatLocale: string;
  readonly project: Omit<
    SeedProject,
    "id" | "createdBy" | "regionConfig" | "status"
  > & {
    readonly language: string;
    readonly formatLocale: string;
  };
  readonly sites: readonly Omit<SeedSite, "id">[];
}

const ORGS: readonly OrgFacts[] = [
  {
    key: "a",
    slug: "seed-sahel-builders",
    legalName: "Sahel Builders Ltd (seed)",
    country: "SL",
    defaultCurrency: "SLE",
    defaultLanguage: "en",
    timezone: "Africa/Freetown",
    dataRegion: "af-south-1",
    reportingCurrency: "USD",
    formatLocale: "en-SL",
    project: {
      code: "SEED-LOS-01",
      name: "Lekki Coastal Road (seed)",
      clientName: "Lagos Roads Agency (seed)",
      currency: "NGN",
      reportingCurrency: "USD",
      timezone: "Africa/Lagos",
      startDate: "2026-01-15",
      endDate: "2027-06-30",
      language: "en",
      formatLocale: "en-NG",
    },
    sites: [
      {
        name: "Lekki main yard (seed)",
        address: "Lekki Phase 1, Lagos (seed)",
        boundary: rectangle(3.47, 6.44, 3.472, 6.442),
      },
      {
        name: "Apapa laydown area (seed)",
        address: "Apapa, Lagos (seed)",
        boundary: rectangle(3.36, 6.45, 3.362, 6.452),
      },
    ],
  },
  {
    key: "b",
    slug: "seed-atlas-constructions",
    legalName: "Atlas Constructions SAS (seed)",
    country: "FR",
    defaultCurrency: "EUR",
    defaultLanguage: "fr",
    timezone: "Europe/Paris",
    dataRegion: "eu-west-1",
    reportingCurrency: "GHS",
    formatLocale: "fr-FR",
    project: {
      code: "SEED-NBO-01",
      name: "Upper Hill Tower (seed)",
      clientName: "Nairobi Estates (seed)",
      currency: "KES",
      reportingCurrency: "EUR",
      timezone: "Africa/Nairobi",
      startDate: "2026-02-01",
      endDate: "2028-03-31",
      language: "ar",
      formatLocale: "ar-KE",
    },
    sites: [
      {
        name: "Upper Hill tower site (seed)",
        address: "Upper Hill, Nairobi (seed)",
        boundary: rectangle(36.815, -1.299, 36.817, -1.297),
      },
      {
        name: "Mombasa Road batching plant (seed)",
        address: "Mombasa Road, Nairobi (seed)",
        boundary: rectangle(36.86, -1.33, 36.862, -1.328),
      },
    ],
  },
];

function buildOrg(facts: OrgFacts, idOf: (name: string) => string): SeedOrg {
  const k = facts.key;
  const roles: SeedRole[] = ROLE_IDS.map((key) => ({
    id: idOf(`role/${k}/${key}`),
    key,
    permissions: (key === "owner" ? [] : ROLES[key]).map((permission) => ({
      id: idOf(`role_permission/${k}/${key}/${permission}`),
      permission,
    })),
  }));
  const users: SeedUser[] = ROLE_IDS.map((role) => ({
    id: idOf(`user/${k}/${role}`),
    sub: `seed-${k}-${role}`,
    role,
    membershipId: idOf(`membership/${k}/${role}`),
  }));
  const userOf = (role: RoleId): string => idOf(`user/${k}/${role}`);
  const roleOf = (role: RoleId): string => idOf(`role/${k}/${role}`);
  const sites: SeedSite[] = facts.sites.map((site, i) => ({
    id: idOf(`site/${k}/${String(i + 1)}`),
    ...site,
  }));
  const { language, formatLocale, ...project } = facts.project;
  return {
    key: k,
    id: idOf(`org/${k}`),
    slug: facts.slug,
    legalName: facts.legalName,
    country: facts.country,
    defaultCurrency: facts.defaultCurrency,
    defaultLanguage: facts.defaultLanguage,
    timezone: facts.timezone,
    units: "metric",
    dataRegion: facts.dataRegion,
    regionConfig: {
      id: idOf(`region_config/${k}`),
      reportingCurrency: facts.reportingCurrency,
      formatLocale: facts.formatLocale,
    },
    roles,
    users,
    project: {
      id: idOf(`project/${k}`),
      ...project,
      status: "active",
      createdBy: userOf("owner"),
      regionConfig: {
        id: idOf(`region_config/${k}/project`),
        language,
        formatLocale,
      },
    },
    sites,
    projectMembers: PROJECT_ROLES.map((role) => ({
      id: idOf(`project_membership/${k}/${role}`),
      userId: userOf(role),
      roleId: roleOf(role),
    })),
    siteAssignments: SITE_ROLES.map((role) => ({
      id: idOf(`project_membership_site/${k}/${role}/1`),
      projectMembershipId: idOf(`project_membership/${k}/${role}`),
      userId: userOf(role),
      siteId: idOf(`site/${k}/1`),
    })),
  };
}

/** The dataset, its ids from `idOf` (seedId: the committed literals). */
export function buildDataset(idOf: (name: string) => string): SeedDataset {
  return {
    instant: SEED_INSTANT,
    orgs: ORGS.map((facts) => buildOrg(facts, idOf)),
  };
}
