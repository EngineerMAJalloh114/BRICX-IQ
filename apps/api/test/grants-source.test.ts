// P5-05 (ADR 0066): the pure part of DbGrantsSource, buildAccess(), over
// the rows the source reads: an org membership's keys (org and own kept,
// project and site dropped), project memberships' effective keys (project
// keys on that project, merged per permission, own kept, org and site
// dropped), the virtual owner bundle, archived roles, unknown keys
// counted, and allProjects from an org-scoped grant on a project- or
// site-level resource alone. The bounds the row caps rest on are checked
// against @bricx/permissions' limits.
// P5-06 (ADR 0067, DW2, DW5): the user's active elevations (access_grants
// rows the source read at the injected Clock) are rows too: an org key
// becomes an org grant, a project key a project grant on its scope_id,
// merged with the membership grants; allProjects comes from the
// membership's org keys alone, never from an elevation; projectIds stay
// the membership's projects; anything else (site, own, unknown) is dropped.
// PR #71 review, amendment 3 (ADR 0067): membershipGrants is the same
// computation without the elevations, the ability grant() checks the
// granter against (no transitive elevation).
import { CATALOGUE } from "@bricx/permissions/catalogue";
import { LIMITS } from "@bricx/permissions/limits";
import { EXTERNAL_ORG_KEYS } from "@bricx/permissions/external";
import { ROLE_IDS, ROLES, type RoleId } from "@bricx/permissions/roles";
import { describe, expect, test } from "vitest";
import {
  type Access,
  type AccessRows,
  MAX_PROJECT_MEMBERSHIPS,
  buildAccess,
} from "../src/common/auth/grants-source.js";

const P1 = "0199e1a0-0000-7000-8000-000000000011";
const P2 = "0199e1a0-0000-7000-8000-000000000012";
const ROLE_A = "0199e1a0-0000-7000-8000-0000000000a0";
const ROLE_B = "0199e1a0-0000-7000-8000-0000000000b0";
const ROLE_OWNER = "0199e1a0-0000-7000-8000-0000000000c0";
/** An org role with no rows (the empty custom role). */
const ROLE_NONE = "0199e1a0-0000-7000-8000-0000000000d0";

const rows = (partial: Partial<AccessRows>): AccessRows => ({
  membership: { roleId: ROLE_A, systemKey: null, archived: false },
  projects: [],
  permissions: new Map(),
  elevations: [],
  ...partial,
});
/** The access without membershipGrants, which each test asserts on its own. */
const apart = (access: Access) => ({
  projectIds: access.projectIds,
  grants: access.grants,
  allProjects: access.allProjects,
  unknownKeys: access.unknownKeys,
});
const project = (projectId: string, roleId: string) => ({
  projectId,
  roleId,
  systemKey: null,
  archived: false,
  overrides: {},
});

describe("buildAccess()", () => {
  test("an org membership: org and own keys as grants, project and site keys dropped, unknown keys counted, no project ids", () => {
    const access = buildAccess(
      rows({
        permissions: new Map([
          [
            ROLE_A,
            [
              "org.member.read.org",
              "project.milestone.read.project",
              "field.dailylog.read.site",
              "nope.nope.nope.org",
              "org.member.read.org",
            ],
          ],
        ]),
      }),
    );
    expect(access.membershipGrants).toEqual(access.grants);
    expect(apart(access)).toEqual({
      projectIds: [],
      grants: [{ permission: "org.member.read", scope: "org" }],
      allProjects: false,
      unknownKeys: 1,
    });
  });

  test("the virtual owner: ROLES.owner from code whatever rows say, allProjects", () => {
    const access = buildAccess(
      rows({
        membership: { roleId: ROLE_OWNER, systemKey: "owner", archived: false },
        permissions: new Map([[ROLE_OWNER, ["org.member.read.org"]]]),
      }),
    );
    expect(access.grants).toHaveLength(ROLES.owner.length);
    expect(access.grants.every((g) => g.scope === "org")).toBe(true);
    expect(access.allProjects).toBe(true);
    expect(access.unknownKeys).toBe(0);
  });

  test("allProjects needs an org-scoped grant on a project- or site-level resource; an org-level one does not set it", () => {
    const of = (key: string) =>
      buildAccess(rows({ permissions: new Map([[ROLE_A, [key]]]) }))
        .allProjects;
    expect(of("supply.material.read.org")).toBe(false);
    expect(of("org.member.read.org")).toBe(false);
    expect(of("project.project.read.org")).toBe(true);
    expect(of("field.dailylog.read.org")).toBe(true);
    // A project-scope grant never does, whatever its resource.
    expect(
      buildAccess(
        rows({
          projects: [
            {
              projectId: P1,
              roleId: ROLE_A,
              systemKey: null,
              archived: false,
              overrides: {},
            },
          ],
          permissions: new Map([[ROLE_A, ["project.project.read.project"]]]),
        }),
      ).allProjects,
    ).toBe(false);
  });

  test("project memberships: effective keys at project scope on that project, merged per permission, sorted; own kept; org and site dropped; the project is listed even when its role grants nothing", () => {
    const access = buildAccess(
      rows({
        membership: { roleId: ROLE_NONE, systemKey: null, archived: false },
        projects: [
          {
            projectId: P2,
            roleId: ROLE_B,
            systemKey: null,
            archived: false,
            overrides: {},
          },
          {
            projectId: P1,
            roleId: ROLE_A,
            systemKey: null,
            archived: false,
            overrides: {
              add: ["project.milestone.verify.project", "nope.nope.nope.own"],
              remove: ["project.milestone.update.project"],
            },
          },
        ],
        permissions: new Map([
          [
            ROLE_A,
            [
              "project.milestone.read.project",
              "project.milestone.update.project",
              "supply.material.read.org",
              "field.dailylog.read.site",
              "field.dailylog.create.own",
            ],
          ],
          [ROLE_B, ["project.milestone.read.project"]],
        ]),
      }),
    );
    expect(access.membershipGrants).toEqual(access.grants);
    expect(apart(access)).toEqual({
      projectIds: [P1, P2],
      grants: [
        { permission: "field.dailylog.create", scope: "own" },
        {
          permission: "project.milestone.read",
          scope: "project",
          projectIds: [P1, P2],
        },
        {
          permission: "project.milestone.verify",
          scope: "project",
          projectIds: [P1],
        },
      ],
      allProjects: false,
      unknownKeys: 1,
    });
  });

  test("an archived role grants nothing (membership and project kept); an owner bundle on a project membership gives its project keys only", () => {
    const access = buildAccess(
      rows({
        membership: { roleId: ROLE_A, systemKey: "auditor", archived: true },
        projects: [
          {
            projectId: P1,
            roleId: ROLE_B,
            systemKey: null,
            archived: true,
            overrides: {},
          },
          {
            projectId: P2,
            roleId: ROLE_OWNER,
            systemKey: "owner",
            archived: false,
            overrides: {},
          },
        ],
        permissions: new Map([
          [ROLE_A, ["org.member.read.org"]],
          [ROLE_B, ["project.milestone.read.project"]],
        ]),
      }),
    );
    expect(access.projectIds).toEqual([P1, P2]);
    expect(access.grants.every((g) => g.scope !== "org")).toBe(true);
    // ROLES.owner is org-scoped throughout: nothing at project level.
    expect(access.grants).toEqual([]);
    expect(access.allProjects).toBe(false);
  });

  test("overrides with non-string entries count as unknown; a missing bundle is empty", () => {
    const access = buildAccess(
      rows({
        projects: [
          {
            projectId: P1,
            roleId: ROLE_B,
            systemKey: null,
            archived: false,
            overrides: {
              add: [7, "project.milestone.read.project"],
              remove: [null],
            },
          },
        ],
      }),
    );
    expect(access.membershipGrants).toEqual(access.grants);
    expect(apart(access)).toEqual({
      projectIds: [P1],
      grants: [
        {
          permission: "project.milestone.read",
          scope: "project",
          projectIds: [P1],
        },
      ],
      allProjects: false,
      unknownKeys: 2,
    });
  });

  test("the row cap keeps every bound of @bricx/permissions", () => {
    const projectKeys = CATALOGUE.filter((k) => k.endsWith(".project")).length;
    expect(MAX_PROJECT_MEMBERSHIPS).toBe(100);
    expect(MAX_PROJECT_MEMBERSHIPS).toBeLessThanOrEqual(LIMITS.targetsPerGrant);
    expect(MAX_PROJECT_MEMBERSHIPS * projectKeys).toBeLessThanOrEqual(
      LIMITS.targetsTotal,
    );
    expect(CATALOGUE.length).toBeLessThanOrEqual(LIMITS.grants);
  });
});

describe("buildAccess() with elevations (P5-06, DW2, DW5)", () => {
  test("an org-scoped elevation is an org grant beside the membership's; the same key twice is one grant", () => {
    const access = buildAccess(
      rows({
        permissions: new Map([[ROLE_A, ["org.member.read.org"]]]),
        elevations: [
          { permission: "org.role.read.org", scopeId: null },
          { permission: "org.role.read.org", scopeId: null },
          { permission: "org.member.read.org", scopeId: null },
        ],
      }),
    );
    // The membership alone (amendment 3): no elevation in it.
    expect(access.membershipGrants).toEqual([
      { permission: "org.member.read", scope: "org" },
    ]);
    expect(apart(access)).toEqual({
      projectIds: [],
      grants: [
        { permission: "org.member.read", scope: "org" },
        { permission: "org.role.read", scope: "org" },
      ],
      allProjects: false,
      unknownKeys: 0,
    });
  });

  test("a project-scoped elevation is a project grant on its scope_id, merged per permission with the membership's projects", () => {
    const access = buildAccess(
      rows({
        membership: { roleId: ROLE_NONE, systemKey: null, archived: false },
        projects: [project(P1, ROLE_B), project(P2, ROLE_B)],
        permissions: new Map([[ROLE_B, ["project.milestone.read.project"]]]),
        elevations: [
          { permission: "finance.budget.approve.project", scopeId: P2 },
          { permission: "project.milestone.read.project", scopeId: P1 },
        ],
      }),
    );
    // The membership alone (amendment 3): no elevation in it.
    expect(access.membershipGrants).toEqual([
      {
        permission: "project.milestone.read",
        scope: "project",
        projectIds: [P1, P2],
      },
    ]);
    expect(apart(access)).toEqual({
      projectIds: [P1, P2],
      grants: [
        {
          permission: "finance.budget.approve",
          scope: "project",
          projectIds: [P2],
        },
        {
          permission: "project.milestone.read",
          scope: "project",
          projectIds: [P1, P2],
        },
      ],
      allProjects: false,
      unknownKeys: 0,
    });
  });

  test("the wildcard never comes from an elevation (DW5): an org key on a project-level resource grants org scope but leaves allProjects and projectIds as the membership set them", () => {
    const access = buildAccess(
      rows({
        membership: { roleId: ROLE_NONE, systemKey: null, archived: false },
        projects: [project(P1, ROLE_B)],
        elevations: [{ permission: "project.project.read.org", scopeId: null }],
      }),
    );
    expect(access.membershipGrants).toEqual([]);
    expect(apart(access)).toEqual({
      projectIds: [P1],
      grants: [{ permission: "project.project.read", scope: "org" }],
      allProjects: false,
      unknownKeys: 0,
    });
    // The same key from the membership does set it (P5-05 unchanged).
    expect(
      buildAccess(
        rows({
          permissions: new Map([[ROLE_A, ["project.project.read.org"]]]),
        }),
      ).allProjects,
    ).toBe(true);
  });

  test("an elevation on a project the user is not a member of grants the key there but adds no project id (RLS keeps the rows hidden; for architect review)", () => {
    const access = buildAccess(
      rows({
        membership: { roleId: ROLE_NONE, systemKey: null, archived: false },
        elevations: [
          { permission: "project.milestone.read.project", scopeId: P2 },
        ],
      }),
    );
    expect(access.projectIds).toEqual([]);
    expect(access.grants).toEqual([
      {
        permission: "project.milestone.read",
        scope: "project",
        projectIds: [P2],
      },
    ]);
  });

  test("dropped: a project key without a scope, an org key with one, a site or own key, a non-project scope id; an unknown key is counted", () => {
    const access = buildAccess(
      rows({
        membership: { roleId: ROLE_NONE, systemKey: null, archived: false },
        elevations: [
          { permission: "project.milestone.read.project", scopeId: null },
          { permission: "org.role.read.org", scopeId: P1 },
          { permission: "field.dailylog.read.site", scopeId: P1 },
          { permission: "field.dailylog.create.own", scopeId: null },
          { permission: "project.milestone.read.project", scopeId: "nope" },
          { permission: "nope.nope.nope.org", scopeId: null },
        ],
      }),
    );
    expect(access.membershipGrants).toEqual([]);
    expect(apart(access)).toEqual({
      projectIds: [],
      grants: [],
      allProjects: false,
      unknownKeys: 1,
    });
  });

  test("membershipGrants never carries an elevation (PR #71 review, amendment 3): an org key held only through an elevation is in grants, not in membershipGrants; held through the role too, it is in both", () => {
    const elevated = buildAccess(
      rows({
        permissions: new Map([[ROLE_A, ["org.access_grant.grant.org"]]]),
        elevations: [
          { permission: "finance.fx_rate.update.org", scopeId: null },
        ],
      }),
    );
    expect(elevated.grants).toEqual([
      { permission: "finance.fx_rate.update", scope: "org" },
      { permission: "org.access_grant.grant", scope: "org" },
    ]);
    expect(elevated.membershipGrants).toEqual([
      { permission: "org.access_grant.grant", scope: "org" },
    ]);
    const both = buildAccess(
      rows({
        permissions: new Map([
          [
            ROLE_A,
            ["org.access_grant.grant.org", "finance.fx_rate.update.org"],
          ],
        ]),
        elevations: [
          { permission: "finance.fx_rate.update.org", scopeId: null },
        ],
      }),
    );
    expect(both.membershipGrants).toEqual(both.grants);
  });

  test("an archived role still grants nothing, while the elevation stands", () => {
    const access = buildAccess(
      rows({
        membership: { roleId: ROLE_A, systemKey: "auditor", archived: true },
        permissions: new Map([[ROLE_A, ["org.member.read.org"]]]),
        elevations: [{ permission: "org.role.read.org", scopeId: null }],
      }),
    );
    expect(access.grants).toEqual([
      { permission: "org.role.read", scope: "org" },
    ]);
  });
});

// P6-05 (ADR 0075 D15, owner conditions C4 and C9): site keys. A project
// membership's site-scope keys become site grants on the sites assigned
// to that membership (project_membership_sites); no assigned site, no
// site key. On an archived site only read keys stay. A site elevation is
// a site grant on its site_id (scope_id its project), with the same
// archived-site rule; a site key elevation without a site, or a project
// or org key carrying one, grants nothing. Site grants never change
// projectIds or allProjects, and membershipGrants never holds an
// elevation's site grant.
describe("buildAccess(): site grants (P6-05, C4, C9)", () => {
  const S1 = "0199e1a0-0000-7000-8000-000000000051";
  const S2 = "0199e1a0-0000-7000-8000-000000000052";
  const S3 = "0199e1a0-0000-7000-8000-000000000053";
  const siteKeys = [
    "field.dailylog.read.site",
    "field.dailylog.update.site",
    "project.site.read.site",
  ];

  test("a membership's site keys on its open assigned sites; on an archived one read keys only", () => {
    const access = buildAccess(
      rows({
        membership: { roleId: ROLE_NONE, systemKey: null, archived: false },
        projects: [
          {
            ...project(P1, ROLE_A),
            sites: [
              { siteId: S2, archived: true },
              { siteId: S1, archived: false },
            ],
          },
        ],
        permissions: new Map([[ROLE_A, siteKeys]]),
      }),
    );
    expect(apart(access)).toEqual({
      projectIds: [P1],
      grants: [
        { permission: "field.dailylog.read", scope: "site", siteIds: [S1, S2] },
        { permission: "field.dailylog.update", scope: "site", siteIds: [S1] },
        { permission: "project.site.read", scope: "site", siteIds: [S1, S2] },
      ],
      allProjects: false,
      unknownKeys: 0,
    });
    expect(access.membershipGrants).toEqual(access.grants);
  });

  test("empty siteIds = no site keys (C4); the project keys stay", () => {
    for (const sites of [[], undefined]) {
      const access = buildAccess(
        rows({
          projects: [
            {
              ...project(P1, ROLE_A),
              ...(sites === undefined ? {} : { sites }),
            },
          ],
          permissions: new Map([
            [ROLE_A, [...siteKeys, "project.milestone.read.project"]],
          ]),
        }),
      );
      expect(access.grants).toEqual([
        {
          permission: "project.milestone.read",
          scope: "project",
          projectIds: [P1],
        },
      ]);
    }
  });

  test("an only-archived assignment keeps read keys and drops the rest", () => {
    const access = buildAccess(
      rows({
        projects: [
          {
            ...project(P1, ROLE_A),
            sites: [{ siteId: S1, archived: true }],
          },
        ],
        permissions: new Map([[ROLE_A, ["field.dailylog.update.site"]]]),
      }),
    );
    expect(access.grants).toEqual([]);
  });

  test("site grants merge per permission across memberships, sorted", () => {
    const access = buildAccess(
      rows({
        projects: [
          { ...project(P2, ROLE_A), sites: [{ siteId: S3, archived: false }] },
          { ...project(P1, ROLE_B), sites: [{ siteId: S1, archived: false }] },
        ],
        permissions: new Map([
          [ROLE_A, ["field.dailylog.read.site"]],
          [ROLE_B, ["field.dailylog.read.site"]],
        ]),
      }),
    );
    expect(access.grants).toEqual([
      { permission: "field.dailylog.read", scope: "site", siteIds: [S1, S3] },
    ]);
  });

  test("a site elevation is a site grant on its site; an archived site keeps read only; membershipGrants never hold it (C9)", () => {
    const access = buildAccess(
      rows({
        projects: [project(P1, ROLE_A)],
        permissions: new Map([[ROLE_A, ["project.milestone.read.project"]]]),
        elevations: [
          {
            permission: "field.dailylog.update.site",
            scopeId: P1,
            siteId: S1,
            siteArchived: false,
          },
          {
            permission: "field.dailylog.update.site",
            scopeId: P1,
            siteId: S2,
            siteArchived: true,
          },
          {
            permission: "field.dailylog.read.site",
            scopeId: P1,
            siteId: S2,
            siteArchived: true,
          },
        ],
      }),
    );
    expect(access.grants).toEqual([
      { permission: "field.dailylog.read", scope: "site", siteIds: [S2] },
      { permission: "field.dailylog.update", scope: "site", siteIds: [S1] },
      {
        permission: "project.milestone.read",
        scope: "project",
        projectIds: [P1],
      },
    ]);
    expect(access.membershipGrants).toEqual([
      {
        permission: "project.milestone.read",
        scope: "project",
        projectIds: [P1],
      },
    ]);
    expect(access.projectIds).toEqual([P1]);
    expect(access.allProjects).toBe(false);
  });

  test("a malformed site elevation grants nothing: a site key without a site, a project or org key with one (C9)", () => {
    const access = buildAccess(
      rows({
        elevations: [
          {
            permission: "field.dailylog.update.site",
            scopeId: P1,
            siteId: null,
          },
          {
            permission: "field.dailylog.update.site",
            scopeId: null,
            siteId: S1,
          },
          {
            permission: "project.milestone.read.project",
            scopeId: P1,
            siteId: S1,
          },
          { permission: "org.member.read.org", scopeId: null, siteId: S1 },
        ],
      }),
    );
    expect(access.grants).toEqual([]);
  });
});

describe("buildAccess(): external members (P6-06b, ADR 0084, C3)", () => {
  /** One comparable string per grant: key, scope and targets. */
  const names = (access: Access) =>
    access.grants.map((g) => JSON.stringify(g)).sort();
  const systemRows = (role: RoleId, external: boolean) =>
    rows({
      membership: { roleId: ROLE_A, systemKey: role, archived: false },
      projects: [
        {
          projectId: P1,
          roleId: ROLE_A,
          systemKey: role,
          archived: false,
          overrides: {},
        },
      ],
      permissions: new Map([[ROLE_A, [...ROLES[role]]]]),
      ...(external ? { external: true } : {}),
    });

  test.each(ROLE_IDS.filter((role) => role !== "owner"))(
    "%s: the external member's grants are a subset of the internal member's with the same rows; of the org role only EXTERNAL_ORG_KEYS stay; never every project; no org-scope finance key",
    (role) => {
      const internal = buildAccess(systemRows(role, false));
      const external = buildAccess(systemRows(role, true));
      const held = new Set(names(internal));
      expect(names(external).filter((n) => !held.has(n))).toEqual([]);
      expect(
        external.grants
          .filter((g) => g.scope === "org")
          .map((g) => `${g.permission}.org`)
          .sort(),
      ).toEqual(
        ROLES[role]
          .filter((key) =>
            (EXTERNAL_ORG_KEYS as readonly string[]).includes(key),
          )
          .sort(),
      );
      expect(external.allProjects).toBe(false);
      expect(external.projectIds).toEqual([P1]);
      expect(
        external.grants.filter(
          (g) => g.scope === "org" && g.permission.startsWith("finance."),
        ),
      ).toEqual([]);
      // The project membership's keys are untouched.
      expect(external.grants.filter((g) => g.scope === "project")).toEqual(
        internal.grants.filter((g) => g.scope === "project"),
      );
      expect(external.unknownKeys).toBe(internal.unknownKeys);
    },
  );

  test("the org role's own-scope keys are dropped for an external member; a project membership's own keys stay", () => {
    const orgOnly = (external: boolean) =>
      buildAccess(
        rows({
          permissions: new Map([
            [ROLE_A, ["project.task.read.own", "org.region_config.read.org"]],
          ]),
          ...(external ? { external: true } : {}),
        }),
      );
    expect(orgOnly(false).grants).toEqual([
      { permission: "org.region_config.read", scope: "org" },
      { permission: "project.task.read", scope: "own" },
    ]);
    expect(orgOnly(true).grants).toEqual([
      { permission: "org.region_config.read", scope: "org" },
    ]);
    const withProject = buildAccess(
      rows({
        projects: [project(P1, ROLE_B)],
        permissions: new Map([
          [ROLE_A, ["project.task.read.own"]],
          [ROLE_B, ["project.task.read.own"]],
        ]),
        external: true,
      }),
    );
    expect(withProject.grants).toEqual([
      { permission: "project.task.read", scope: "own" },
    ]);
  });

  test("no org-scope elevation counts for an external member, in grants or membershipGrants; a project one on its scope does", () => {
    const elevated = (external: boolean) =>
      buildAccess(
        rows({
          projects: [project(P1, ROLE_B)],
          permissions: new Map([[ROLE_A, ["org.member.read.org"]]]),
          elevations: [
            { permission: "org.role.read.org", scopeId: null },
            { permission: "finance.fx_rate.update.org", scopeId: null },
            { permission: "finance.budget.approve.project", scopeId: P1 },
          ],
          ...(external ? { external: true } : {}),
        }),
      );
    expect(
      elevated(false)
        .grants.map((g) => `${g.permission}.${g.scope}`)
        .sort(),
    ).toEqual([
      "finance.budget.approve.project",
      "finance.fx_rate.update.org",
      "org.member.read.org",
      "org.role.read.org",
    ]);
    const external = elevated(true);
    expect(external.grants).toEqual([
      {
        permission: "finance.budget.approve",
        scope: "project",
        projectIds: [P1],
      },
    ]);
    expect(external.membershipGrants).toEqual([]);
    expect(external.allProjects).toBe(false);
  });

  test("external false or absent is an internal member", () => {
    const base = { permissions: new Map([[ROLE_A, ["org.member.read.org"]]]) };
    expect(buildAccess(rows({ ...base, external: false })).grants).toEqual(
      buildAccess(rows(base)).grants,
    );
    expect(buildAccess(rows(base)).grants).toHaveLength(1);
  });
});
