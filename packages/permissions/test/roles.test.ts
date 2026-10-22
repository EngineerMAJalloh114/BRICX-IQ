// Default role bundles (ROADMAP P3-05 step 2; Done when: "ability tests for
// every default role x 10 sample actions"). The expected values below are
// written by hand from the approved plan and the architect's ruling 4; they
// are not derived from src/roles.ts, so they act as an independent oracle.
import { describe, expect, it } from "vitest";
import { buildAbility, can } from "../src/ability.ts";
import type { PermissionRecord } from "../src/ability.ts";
import { CATALOGUE, PERMISSIONS, RESOURCES } from "../src/catalogue.ts";
import type { PermissionName } from "../src/catalogue.ts";
import { ROLES, ROLE_IDS, grantsForRole } from "../src/roles.ts";
import type { RoleId } from "../src/roles.ts";
import {
  CONTEXT,
  IN_SCOPE,
  OTHER_ORG,
  OTHER_PROJECT,
  OTHER_USER,
  TARGETS,
} from "./helpers.ts";

const permissionsOf = (role: RoleId): string[] =>
  ROLES[role].map((k) => k.slice(0, k.lastIndexOf(".")));

describe("the 12 default roles", () => {
  it("are exactly the ROADMAP's list, in order", () => {
    expect([...ROLE_IDS]).toEqual([
      "owner",
      "project_owner",
      "project_manager",
      "quantity_surveyor",
      "site_engineer",
      "foreman",
      "storekeeper",
      "accountant",
      "client",
      "consultant",
      "subcontractor",
      "auditor",
    ]);
  });

  it.each(ROLE_IDS)(
    "%s lists every entry explicitly, each in the catalogue, no duplicates, one scope per permission",
    (role) => {
      const keys = ROLES[role];
      expect(keys.length).toBeGreaterThan(0);
      expect(new Set(keys).size).toBe(keys.length);
      for (const key of keys) expect(CATALOGUE).toContain(key);
      const perms = permissionsOf(role);
      expect(new Set(perms).size).toBe(perms.length);
    },
  );

  it("Owner holds every permission at org scope (enumerated, no wildcard)", () => {
    expect([...ROLES.owner].sort()).toEqual(
      PERMISSIONS.map((p) => `${p}.org`).sort(),
    );
  });

  it("Auditor holds every read, plus org.audit.export and finance.ledger.export, at org scope, and nothing else (ruling 4d)", () => {
    const expected = [
      ...PERMISSIONS.filter((p) => p.endsWith(".read")),
      "org.audit.export",
      "finance.ledger.export",
    ].map((p) => `${p}.org`);
    expect([...ROLES.auditor].sort()).toEqual(expected.sort());
    const actions = new Set(
      permissionsOf("auditor").map((p) => p.slice(p.lastIndexOf(".") + 1)),
    );
    expect([...actions].sort()).toEqual(["export", "read"]);
    for (const p of permissionsOf("auditor").filter((x) =>
      x.endsWith(".export"),
    )) {
      expect(["org.audit.export", "finance.ledger.export"]).toContain(p);
    }
  });

  it("org.session: owner reads and revokes, auditor reads, no other role holds it (P5-03, ADR 0063)", () => {
    expect(ROLES.owner).toContain("org.session.read.org");
    expect(ROLES.owner).toContain("org.session.revoke.org");
    expect(ROLES.auditor).toContain("org.session.read.org");
    expect(ROLES.auditor).not.toContain("org.session.revoke.org");
    for (const role of ROLE_IDS.filter(
      (r) => r !== "owner" && r !== "auditor",
    )) {
      expect(
        permissionsOf(role).filter((p) => p.startsWith("org.session.")),
        role,
      ).toEqual([]);
    }
  });

  // P5-06 (ADR 0067, D-A): only the owner bundle grants and revokes
  // elevations by default; the auditor sees them (read is part of "every
  // read"); no other default bundle touches them.
  it("org.access_grant: owner reads, grants and revokes, auditor reads, no other role holds it (P5-06, ADR 0067)", () => {
    const owner: readonly string[] = ROLES.owner;
    const auditor: readonly string[] = ROLES.auditor;
    expect(owner).toContain("org.access_grant.read.org");
    expect(owner).toContain("org.access_grant.grant.org");
    expect(owner).toContain("org.access_grant.revoke.org");
    expect(auditor).toContain("org.access_grant.read.org");
    expect(auditor).not.toContain("org.access_grant.grant.org");
    expect(auditor).not.toContain("org.access_grant.revoke.org");
    for (const role of ROLE_IDS.filter(
      (r) => r !== "owner" && r !== "auditor",
    )) {
      expect(
        permissionsOf(role).filter((p) => p.startsWith("org.access_grant.")),
        role,
      ).toEqual([]);
    }
  });

  it("only Owner can create projects (ruling 4e)", () => {
    for (const role of ROLE_IDS) {
      expect(permissionsOf(role).includes("project.project.create"), role).toBe(
        role === "owner",
      );
    }
  });

  it("document.file.share only for Owner, Project Owner and Project Manager (ruling 4c)", () => {
    const holders = ROLE_IDS.filter((r) =>
      permissionsOf(r).includes("document.file.share"),
    );
    expect(holders).toEqual(["owner", "project_owner", "project_manager"]);
  });

  it("Client has no finance.payment.read and no report.dashboard.read, keeps milestone verify and change_order sign_off (ruling 4a)", () => {
    const client = permissionsOf("client");
    expect(client).not.toContain("finance.payment.read");
    expect(client).not.toContain("report.dashboard.read");
    expect(client).toContain("project.milestone.verify");
    expect(client).toContain("finance.change_order.sign_off");
  });

  it("Subcontractor reads files at own scope only, never site-wide (architect review 3)", () => {
    expect(ROLES.subcontractor).toContain("document.file.read.own");
    expect(ROLES.subcontractor).not.toContain("document.file.read.site");
    const ability = buildAbility(
      grantsForRole("subcontractor", TARGETS),
      CONTEXT,
    );
    expect(can(ability, "read", "document.file", IN_SCOPE)).toBe(true);
    expect(
      can(ability, "read", "document.file", {
        ...IN_SCOPE,
        createdBy: OTHER_USER,
      }),
    ).toBe(false);
  });

  it("Consultant has no report.dashboard.read (ruling 4b)", () => {
    expect(permissionsOf("consultant")).not.toContain("report.dashboard.read");
  });
});

// Ruling 4f: each role x each forbidden family, written out one by one.
describe("field and outside roles hold no ledger, fx, budget, audit or role permission (ruling 4f)", () => {
  const FAMILIES = [
    "finance.ledger.",
    "finance.fx_rate.",
    "finance.budget.",
    "org.audit.",
    "org.role.",
  ] as const;
  it.each([
    ["foreman", "finance.ledger."],
    ["foreman", "finance.fx_rate."],
    ["foreman", "finance.budget."],
    ["foreman", "org.audit."],
    ["foreman", "org.role."],
    ["storekeeper", "finance.ledger."],
    ["storekeeper", "finance.fx_rate."],
    ["storekeeper", "finance.budget."],
    ["storekeeper", "org.audit."],
    ["storekeeper", "org.role."],
    ["subcontractor", "finance.ledger."],
    ["subcontractor", "finance.fx_rate."],
    ["subcontractor", "finance.budget."],
    ["subcontractor", "org.audit."],
    ["subcontractor", "org.role."],
    ["site_engineer", "finance.ledger."],
    ["site_engineer", "finance.fx_rate."],
    ["site_engineer", "finance.budget."],
    ["site_engineer", "org.audit."],
    ["site_engineer", "org.role."],
    ["client", "finance.ledger."],
    ["client", "finance.fx_rate."],
    ["client", "finance.budget."],
    ["client", "org.audit."],
    ["client", "org.role."],
    ["consultant", "finance.ledger."],
    ["consultant", "finance.fx_rate."],
    ["consultant", "finance.budget."],
    ["consultant", "org.audit."],
    ["consultant", "org.role."],
  ] as const)("%s holds no %s* permission", (role, family) => {
    expect(FAMILIES).toContain(family);
    expect(ROLES[role].filter((k) => k.startsWith(family))).toEqual([]);
    const ability = buildAbility(grantsForRole(role, TARGETS), CONTEXT);
    for (const p of PERMISSIONS.filter((x) => x.startsWith(family))) {
      const subject = p.slice(0, p.lastIndexOf(".")) as keyof typeof RESOURCES;
      const action = p.slice(p.lastIndexOf(".") + 1);
      expect(
        can(ability, action as never, subject, IN_SCOPE),
        `${role} ${p}`,
      ).toBe(false);
    }
  });
});

/**
 * The 10 sample actions. Every one is checked against a record in scope
 * (org A, project 1, site 1, created by the user), a record in another
 * project of the same org (created by someone else) and a record of org B.
 */
const SAMPLES = [
  "finance.payment.approve",
  "finance.payment.record",
  "field.dailylog.create",
  "supply.goods_receipt.create",
  "finance.budget.approve",
  "org.role.manage",
  "project.project.read",
  "field.attendance.approve",
  "supply.material_request.create",
  "org.audit.read",
] as const satisfies readonly PermissionName[];

/**
 * Hand-written oracle: "O" = allowed org-wide (also in another project),
 * "Y" = allowed in scope only, "-" = denied. Never allowed in another org.
 */
const ORACLE: Record<RoleId, string> = {
  //                 pay.ap pay.rec dl.cr gr.cr bud.ap role.mg prj.rd att.ap mr.cr aud.rd
  owner: "O O O O O O O O O O",
  project_owner: "Y - Y Y Y - Y Y Y -",
  project_manager: "- - Y - - - Y Y Y -",
  quantity_surveyor: "- - - - - - Y - - -",
  site_engineer: "- - Y - - - Y Y Y -",
  foreman: "- - Y - - - Y - Y -",
  storekeeper: "- - - Y - - Y - - -",
  accountant: "- O - - - - O - - -",
  client: "- - - - - - Y - - -",
  consultant: "- - - - - - Y - - -",
  subcontractor: "- - Y - - - Y - Y -",
  auditor: "- - - - - - O - - O",
};

/** The record of a subject type: only the fields its level carries. */
function recordFor(
  subject: keyof typeof RESOURCES,
  base: PermissionRecord,
): PermissionRecord {
  const r = RESOURCES[subject];
  return {
    orgId: base.orgId,
    ...(r.level === "org" ? {} : { projectId: base.projectId }),
    ...(r.level === "site" ? { siteId: base.siteId } : {}),
    ...(r.createdBy ? { createdBy: base.createdBy } : {}),
  };
}

describe("every default role x 10 sample actions", () => {
  const cases = ROLE_IDS.flatMap((role) => {
    const row = ORACLE[role].split(" ");
    return SAMPLES.map((permission, i) => [role, permission, row[i]] as const);
  });
  it("the oracle has one row of 10 per role", () => {
    for (const role of ROLE_IDS) {
      expect(ORACLE[role].split(" "), role).toHaveLength(10);
    }
    expect(cases).toHaveLength(120);
  });

  it.each(cases)("%s %s -> %s", (role, permission, expected) => {
    const ability = buildAbility(grantsForRole(role, TARGETS), CONTEXT);
    const subject = permission.slice(
      0,
      permission.lastIndexOf("."),
    ) as keyof typeof RESOURCES;
    const action = permission.slice(permission.lastIndexOf(".") + 1);
    const check = (base: PermissionRecord) =>
      can(ability, action as never, subject, recordFor(subject, base));
    expect(check(IN_SCOPE), "in scope").toBe(expected !== "-");
    expect(check(OTHER_PROJECT), "other project").toBe(expected === "O");
    expect(check(OTHER_ORG), "other org").toBe(false);
  });
});

describe("grantsForRole", () => {
  it("needs project targets for a project-scoped bundle and site targets for a site-scoped one", () => {
    expect(() => grantsForRole("project_manager", {})).toThrow(
      expect.objectContaining({ code: "invalid_grants" }),
    );
    expect(() =>
      grantsForRole("foreman", { projectIds: TARGETS.projectIds }),
    ).toThrow(expect.objectContaining({ code: "invalid_grants" }));
    expect(grantsForRole("owner", {}).every((g) => g.scope === "org")).toBe(
      true,
    );
  });

  it("gives every role a grant per bundle entry", () => {
    for (const role of ROLE_IDS) {
      expect(grantsForRole(role, TARGETS)).toHaveLength(ROLES[role].length);
    }
  });
});
