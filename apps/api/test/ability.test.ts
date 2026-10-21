// abilityFor(identity) (P4-09, ADR 0059; P5-02, ADR 0062, owner condition
// 1): the ability is built from the identity's grants, which the auth
// guard takes from the grants source (production: none until P5-05). No
// role name reaches it: an identity carries no roles, and a `roles` field
// smuggled onto one is ignored. Deny by default, every grant pinned to the
// identity's org. The grants below come from test/support (the role
// bundles a P5-05 membership would give).
import { can } from "@bricx/permissions/ability";
import { describe, expect, it } from "vitest";
import { abilityFor } from "../src/common/auth/ability.js";
import type { Identity } from "../src/common/db/request-context.js";
import { ApiError } from "../src/common/errors/api-error.js";
import { type TestAccess, grantsOf } from "./support/auth.js";

const ORG = "0199e1a0-0000-7000-8000-0000000000a1";
const OTHER_ORG = "0199e1a0-0000-7000-8000-0000000000b1";
const USER = "0199e1a0-0000-7000-8000-0000000000a2";
const PROJECT = "0199e1a0-0000-7000-8000-0000000000a3";
const OTHER_PROJECT = "0199e1a0-0000-7000-8000-0000000000b3";

const identity = (
  access: TestAccess,
  projectIds: readonly string[] = access.projects ?? [],
): Identity => ({
  orgId: ORG,
  userId: USER,
  projectIds,
  grants: grantsOf(access),
});

const milestone = (orgId = ORG, projectId = PROJECT) => ({
  orgId,
  projectId,
  createdBy: USER,
});

const canCreate = (who: Identity, record = milestone()) =>
  can(abilityFor(who), "create", "project.milestone", record);
const canRead = (who: Identity, record = milestone()) =>
  can(abilityFor(who), "read", "project.milestone", record);

const errorOf = (run: () => unknown): unknown => {
  try {
    run();
  } catch (caught) {
    return caught;
  }
  return undefined;
};

describe("abilityFor(identity)", () => {
  it("no grants (production before P5-05): no permission at all", () => {
    const who = identity({});
    expect(canCreate(who)).toBe(false);
    expect(canRead(who)).toBe(false);
    expect(can(abilityFor(who), "read", "org.audit", { orgId: ORG })).toBe(
      false,
    );
  });

  it("a roles field on the identity is ignored: there is no role-claim path", () => {
    const smuggled = Object.assign(identity({}), { roles: ["owner"] });
    expect(canCreate(smuggled)).toBe(false);
    expect(canRead(smuggled)).toBe(false);
  });

  it("project_manager grants: create and read on its own projects only", () => {
    const who = identity({ projects: [PROJECT], roles: ["project_manager"] });
    expect(canCreate(who)).toBe(true);
    expect(canRead(who)).toBe(true);
    expect(canCreate(who, milestone(ORG, OTHER_PROJECT))).toBe(false);
    expect(canCreate(who, milestone(OTHER_ORG))).toBe(false);
  });

  it("quantity_surveyor grants: read, never create", () => {
    const who = identity({ projects: [PROJECT], roles: ["quantity_surveyor"] });
    expect(canRead(who)).toBe(true);
    expect(canCreate(who)).toBe(false);
  });

  it("owner grants: org-wide, but only in its own org", () => {
    const who = identity({ roles: ["owner"] });
    expect(canCreate(who, milestone(ORG, OTHER_PROJECT))).toBe(true);
    expect(canCreate(who, milestone(OTHER_ORG))).toBe(false);
  });

  it("ids that are not UUIDv7 are forbidden, never a 500", () => {
    const error = errorOf(() =>
      abilityFor({ ...identity({ roles: ["owner"] }), orgId: "not-a-uuid" }),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "forbidden" });
  });

  it("grants that are not valid grants are forbidden (fail closed), never a 500", () => {
    const bad = {
      ...identity({}),
      grants: [
        JSON.parse(
          '{"permission":"project.milestone.create","scope":"any"}',
        ) as never,
      ],
    };
    const error = errorOf(() => abilityFor(bad));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "forbidden" });
  });
});
