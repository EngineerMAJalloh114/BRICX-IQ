// buildAbility and the one checked entry point (ROADMAP P3-05 step 3;
// architect ruling 1). The raw CASL ability is never handed out: a
// subject-TYPE check ignores conditions, so every check goes through
// can(ability, action, subjectType, record), which needs a record with the
// closed fields and fails closed without one.
import { describe, expect, it } from "vitest";
import {
  accessibleQuery,
  buildAbility,
  can,
  canPermission,
  rulesOf,
} from "../src/ability.ts";
import type { Grant, PermissionRecord } from "../src/ability.ts";
import { PERMISSIONS } from "../src/catalogue.ts";
import {
  CONTEXT,
  IN_SCOPE,
  ORG_A,
  ORG_B,
  OTHER_ORG,
  OTHER_PROJECT,
  OTHER_USER,
  PROJECT_1,
  PROJECT_2,
  SITE_1,
  USER,
  uuid,
} from "./helpers.ts";

const projectGrant: Grant = {
  permission: "finance.payment.approve",
  scope: "project",
  projectIds: [PROJECT_1],
};
const pm = buildAbility([projectGrant], CONTEXT);
const payment = (projectId: string): PermissionRecord => ({
  orgId: ORG_A,
  projectId,
  createdBy: OTHER_USER,
});

describe("fail closed (ruling 1)", () => {
  it("a type-only check is denied: no record throws invalid_record", () => {
    for (const missing of [undefined, null, "finance.payment", 1, []]) {
      expect(() =>
        can(pm, "approve", "finance.payment", missing as never),
      ).toThrow(expect.objectContaining({ code: "invalid_record" }));
    }
  });

  it("a record without projectId is denied for a project-scoped grant", () => {
    expect(() =>
      can(pm, "approve", "finance.payment", {
        orgId: ORG_A,
        createdBy: USER,
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_record" }));
  });

  it("orgId or the scope field undefined, not a string or not a lowercase UUIDv7 is denied", () => {
    const bad: unknown[] = [
      { projectId: PROJECT_1, createdBy: USER },
      { orgId: undefined, projectId: PROJECT_1, createdBy: USER },
      { orgId: 1, projectId: PROJECT_1, createdBy: USER },
      { orgId: ORG_A.toUpperCase(), projectId: PROJECT_1, createdBy: USER },
      { orgId: ORG_A, projectId: 7, createdBy: USER },
      { orgId: ORG_A, projectId: { $ne: null }, createdBy: USER },
      { orgId: ORG_A, projectId: [PROJECT_1], createdBy: USER },
      { orgId: ORG_A, projectId: PROJECT_1 },
      { orgId: ORG_A, projectId: PROJECT_1, createdBy: null },
    ];
    for (const record of bad) {
      expect(() =>
        can(pm, "approve", "finance.payment", record as PermissionRecord),
      ).toThrow(expect.objectContaining({ code: "invalid_record" }));
    }
  });

  it("a site-level record needs siteId; an org-level record needs only orgId", () => {
    const foreman = buildAbility(
      [{ permission: "field.dailylog.read", scope: "site", siteIds: [SITE_1] }],
      CONTEXT,
    );
    expect(() =>
      can(foreman, "read", "field.dailylog", {
        orgId: ORG_A,
        projectId: PROJECT_1,
        createdBy: USER,
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_record" }));
    const admin = buildAbility(
      [{ permission: "org.role.read", scope: "org" }],
      CONTEXT,
    );
    expect(can(admin, "read", "org.role", { orgId: ORG_A })).toBe(true);
  });

  it("a record of another org is denied, even for an org-scoped grant", () => {
    const owner = buildAbility(
      [{ permission: "finance.payment.approve", scope: "org" }],
      CONTEXT,
    );
    expect(can(owner, "approve", "finance.payment", payment(PROJECT_1))).toBe(
      true,
    );
    expect(
      can(owner, "approve", "finance.payment", {
        ...payment(PROJECT_1),
        orgId: ORG_B,
      }),
    ).toBe(false);
    expect(can(pm, "approve", "finance.payment", OTHER_ORG)).toBe(false);
  });

  it("a project grant allows its projects only", () => {
    expect(can(pm, "approve", "finance.payment", payment(PROJECT_1))).toBe(
      true,
    );
    expect(can(pm, "approve", "finance.payment", payment(PROJECT_2))).toBe(
      false,
    );
  });

  it("extra fields on the record cannot widen a check", () => {
    const record = {
      ...payment(PROJECT_2),
      kind: "finance.payment",
      __caslSubjectType__: "finance.payment",
      constructor: { modelName: "finance.payment" },
    };
    expect(can(pm, "approve", "finance.payment", record)).toBe(false);
  });

  it("an unknown subject type or an action the subject lacks throws", () => {
    expect(() =>
      can(pm, "approve", "finance.unknown" as never, IN_SCOPE),
    ).toThrow(expect.objectContaining({ code: "unknown_permission" }));
    expect(() =>
      can(pm, "manage" as never, "finance.payment", IN_SCOPE),
    ).toThrow(expect.objectContaining({ code: "unknown_permission" }));
  });

  it("a forged ability object throws", () => {
    expect(() =>
      can({} as never, "approve", "finance.payment", IN_SCOPE),
    ).toThrow(expect.objectContaining({ code: "invalid_ability" }));
  });
});

describe("deny by default, no wildcard", () => {
  it("no grants: every catalogue permission is denied", () => {
    const none = buildAbility([], CONTEXT);
    for (const p of PERMISSIONS) {
      const subject = p.slice(0, p.lastIndexOf("."));
      const action = p.slice(p.lastIndexOf(".") + 1);
      expect(can(none, action as never, subject as never, IN_SCOPE), p).toBe(
        false,
      );
    }
  });

  it("org.role.manage is a literal action, not CASL's 'manage' wildcard (D5)", () => {
    const manager = buildAbility(
      [{ permission: "org.role.manage", scope: "org" }],
      CONTEXT,
    );
    expect(can(manager, "manage", "org.role", { orgId: ORG_A })).toBe(true);
    expect(can(manager, "read", "org.role", { orgId: ORG_A })).toBe(false);
  });

  it("the rules never use manage on another subject, all, or an inverted rule", () => {
    const owner = buildAbility(
      PERMISSIONS.map((permission) => ({ permission, scope: "org" as const })),
      CONTEXT,
    );
    for (const rule of rulesOf(owner)) {
      expect(rule.subject).not.toBe("all");
      expect(rule.inverted).toBeUndefined();
      if (rule.action === "manage") expect(rule.subject).toBe("org.role");
      expect(rule.conditions.orgId).toBe(ORG_A);
    }
  });
});

describe("scope conditions (D4)", () => {
  it("site grants match siteId, own grants match createdBy", () => {
    const ability = buildAbility(
      [
        { permission: "field.photo.read", scope: "site", siteIds: [SITE_1] },
        { permission: "field.photo.create", scope: "own" },
      ],
      CONTEXT,
    );
    const photo = (siteId: string, createdBy: string): PermissionRecord => ({
      orgId: ORG_A,
      projectId: PROJECT_1,
      siteId,
      createdBy,
    });
    expect(can(ability, "read", "field.photo", photo(SITE_1, OTHER_USER))).toBe(
      true,
    );
    expect(can(ability, "read", "field.photo", photo(uuid(99), USER))).toBe(
      false,
    );
    expect(can(ability, "create", "field.photo", photo(uuid(99), USER))).toBe(
      true,
    );
    expect(
      can(ability, "create", "field.photo", photo(SITE_1, OTHER_USER)),
    ).toBe(false);
  });

  it("an org grant covers every project of the org", () => {
    const ability = buildAbility(
      [{ permission: "field.photo.read", scope: "org" }],
      CONTEXT,
    );
    expect(can(ability, "read", "field.photo", OTHER_PROJECT)).toBe(true);
  });
});

describe("grant and context validation", () => {
  it("an unknown permission, a disallowed scope or a bad shape throws a code", () => {
    const cases: [unknown, string][] = [
      [
        [{ permission: "finance.payment.steal", scope: "org" }],
        "unknown_permission",
      ],
      [
        [{ permission: "finance.payment.approve", scope: "own" }],
        "scope_not_allowed",
      ],
      [
        [
          {
            permission: "project.project.create",
            scope: "project",
            projectIds: [PROJECT_1],
          },
        ],
        "scope_not_allowed",
      ],
      [
        [{ permission: "finance.payment.approve", scope: "galaxy" }],
        "invalid_grants",
      ],
      [
        [{ permission: "finance.payment.approve", scope: "project" }],
        "invalid_grants",
      ],
      [
        [
          {
            permission: "finance.payment.approve",
            scope: "project",
            projectIds: [],
          },
        ],
        "invalid_grants",
      ],
      [
        [
          {
            permission: "finance.payment.approve",
            scope: "project",
            projectIds: ["nope"],
          },
        ],
        "invalid_grants",
      ],
      [
        [
          {
            permission: "finance.payment.approve",
            scope: "org",
            projectIds: [PROJECT_1],
          },
        ],
        "invalid_grants",
      ],
      [
        [
          {
            permission: "field.photo.read",
            scope: "site",
            projectIds: [PROJECT_1],
          },
        ],
        "invalid_grants",
      ],
      [
        [{ permission: "finance.payment.approve", scope: "org", extra: 1 }],
        "invalid_grants",
      ],
      [[null], "invalid_grants"],
      [["finance.payment.approve.org"], "invalid_grants"],
      ["not an array", "invalid_grants"],
    ];
    for (const [grants, code] of cases) {
      expect(
        () => buildAbility(grants as Grant[], CONTEXT),
        JSON.stringify(grants),
      ).toThrow(expect.objectContaining({ code }));
    }
  });

  it("a context without valid org and user ids throws invalid_context", () => {
    for (const context of [
      undefined,
      {},
      { orgId: ORG_A },
      { orgId: ORG_A, userId: "user" },
      { orgId: ORG_A.toUpperCase(), userId: USER },
      { orgId: ORG_A, userId: USER, projectIds: [PROJECT_1] },
    ]) {
      expect(() => buildAbility([], context as never)).toThrow(
        expect.objectContaining({ code: "invalid_context" }),
      );
    }
  });
});

describe("accessibleQuery: the list-query helper, fail closed", () => {
  it("no rule gives none", () => {
    expect(accessibleQuery(pm, "read", "finance.payment")).toEqual({
      kind: "none",
    });
  });

  it("gives one filter per grant, in grant order, each pinned to the org", () => {
    const ability = buildAbility(
      [
        {
          permission: "field.photo.read",
          scope: "project",
          projectIds: [PROJECT_1, PROJECT_2],
        },
        { permission: "field.photo.read", scope: "site", siteIds: [SITE_1] },
        { permission: "field.photo.read", scope: "own" },
      ],
      CONTEXT,
    );
    expect(accessibleQuery(ability, "read", "field.photo")).toEqual({
      kind: "any_of",
      filters: [
        { orgId: ORG_A, projectIds: [PROJECT_1, PROJECT_2] },
        { orgId: ORG_A, siteIds: [SITE_1] },
        { orgId: ORG_A, createdBy: USER },
      ],
    });
    const owner = buildAbility(
      [{ permission: "field.photo.read", scope: "org" }],
      CONTEXT,
    );
    expect(accessibleQuery(owner, "read", "field.photo")).toEqual({
      kind: "any_of",
      filters: [{ orgId: ORG_A }],
    });
  });

  it("an unknown subject or action, or a forged ability, throws", () => {
    expect(() => accessibleQuery(pm, "read", "x.y" as never)).toThrow(
      expect.objectContaining({ code: "unknown_permission" }),
    );
    expect(() =>
      accessibleQuery(pm, "manage" as never, "finance.payment"),
    ).toThrow(expect.objectContaining({ code: "unknown_permission" }));
    expect(() =>
      accessibleQuery({} as never, "read", "finance.payment"),
    ).toThrow(expect.objectContaining({ code: "invalid_ability" }));
  });
});

describe("the ability handle is opaque", () => {
  it("exposes no CASL method", () => {
    const handle = pm as unknown as Record<string, unknown>;
    expect(handle.can).toBeUndefined();
    expect(handle.cannot).toBeUndefined();
    expect(handle.rulesFor).toBeUndefined();
    expect(Object.isFrozen(pm)).toBe(true);
  });
});

// P5-05 (ADR 0066): canPermission() is can() for a permission name read
// from a stored catalogue key (a role's rows), checked at run time instead
// of at the type level, so the API's escalation check needs no cast.
describe("canPermission(): can() for a stored permission name", () => {
  const owner = buildAbility(
    PERMISSIONS.map((permission) => ({ permission, scope: "org" }) as const),
    CONTEXT,
  );

  it("agrees with can() on every catalogue permission, for an org-wide ability and a project one", () => {
    for (const permission of PERMISSIONS) {
      const dot = permission.lastIndexOf(".");
      const subject = permission.slice(0, dot);
      const action = permission.slice(dot + 1);
      for (const ability of [owner, pm]) {
        expect(canPermission(ability, permission, IN_SCOPE), permission).toBe(
          can(ability, action as never, subject as never, IN_SCOPE),
        );
      }
    }
    expect(canPermission(owner, "finance.payment.approve", IN_SCOPE)).toBe(
      true,
    );
    expect(canPermission(pm, "finance.payment.approve", IN_SCOPE)).toBe(true);
    expect(
      canPermission(pm, "finance.payment.approve", payment(PROJECT_2)),
    ).toBe(false);
  });

  it("an unknown permission throws unknown_permission; a record without the resource's fields throws invalid_record", () => {
    for (const bad of [
      "nope.nope.nope",
      "finance.payment",
      "",
      "finance.payment.approve.project",
    ]) {
      expect(() => canPermission(owner, bad, IN_SCOPE)).toThrow(
        expect.objectContaining({ code: "unknown_permission" }),
      );
    }
    expect(() =>
      canPermission(owner, "finance.payment.approve", { orgId: ORG_A }),
    ).toThrow(expect.objectContaining({ code: "invalid_record" }));
  });
});
