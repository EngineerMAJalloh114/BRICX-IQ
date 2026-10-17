// abilityFor(identity) (P4-09, ADR 0059, owner condition 5): the stand-in
// that turns the request identity's role names into a @bricx/permissions
// ability until P5 replaces it. Deny by default: an empty, unknown or
// unusable role grants nothing, and every grant is pinned to the
// identity's org and projects.
import { can } from "@bricx/permissions/ability";
import { describe, expect, it } from "vitest";
import { abilityFor } from "../src/common/auth/ability.js";
import type { Identity } from "../src/common/db/request-context.js";
import { ApiError } from "../src/common/errors/api-error.js";

const ORG = "0199e1a0-0000-7000-8000-0000000000a1";
const OTHER_ORG = "0199e1a0-0000-7000-8000-0000000000b1";
const USER = "0199e1a0-0000-7000-8000-0000000000a2";
const PROJECT = "0199e1a0-0000-7000-8000-0000000000a3";
const OTHER_PROJECT = "0199e1a0-0000-7000-8000-0000000000b3";

const identity = (
  roles: readonly string[],
  projectIds: readonly string[] = [PROJECT],
): Identity => ({ orgId: ORG, userId: USER, projectIds, roles });

const milestone = (orgId = ORG, projectId = PROJECT) => ({
  orgId,
  projectId,
  createdBy: USER,
});

const canCreate = (who: Identity, record = milestone()) =>
  can(abilityFor(who), "create", "project.milestone", record);
const canRead = (who: Identity, record = milestone()) =>
  can(abilityFor(who), "read", "project.milestone", record);

describe("abilityFor(identity)", () => {
  it.each([
    ["no roles", []],
    ["an unknown role", ["superuser"]],
    ["an empty role name", [""]],
    ["prototype names", ["constructor", "__proto__", "toString"]],
    ["a role's name in another case", ["Project_Manager"]],
  ])("%s: no permission at all", (_what, roles) => {
    const who = identity(roles);
    expect(canCreate(who)).toBe(false);
    expect(canRead(who)).toBe(false);
    expect(can(abilityFor(who), "read", "org.audit", { orgId: ORG })).toBe(
      false,
    );
  });

  it("project_manager: create and read on its own projects only", () => {
    const who = identity(["project_manager"]);
    expect(canCreate(who)).toBe(true);
    expect(canRead(who)).toBe(true);
    expect(canCreate(who, milestone(ORG, OTHER_PROJECT))).toBe(false);
    expect(canCreate(who, milestone(OTHER_ORG))).toBe(false);
  });

  it("a project role without projects grants nothing (fail closed)", () => {
    expect(canCreate(identity(["project_manager"], []))).toBe(false);
    expect(canRead(identity(["project_manager"], []))).toBe(false);
  });

  it("a site role needs sites the identity cannot carry yet: it grants nothing", () => {
    expect(canRead(identity(["foreman"]))).toBe(false);
  });

  it("quantity_surveyor: read, never create", () => {
    const who = identity(["quantity_surveyor"]);
    expect(canRead(who)).toBe(true);
    expect(canCreate(who)).toBe(false);
  });

  it("owner: org-wide, but only in its own org", () => {
    const who = identity(["owner"], []);
    expect(canCreate(who, milestone(ORG, OTHER_PROJECT))).toBe(true);
    expect(canCreate(who, milestone(OTHER_ORG))).toBe(false);
  });

  it("an unknown role beside a real one changes nothing", () => {
    expect(canCreate(identity(["nobody", "project_manager"]))).toBe(true);
  });

  it("ids that are not UUIDv7 are forbidden, never a 500", () => {
    const error = (() => {
      try {
        abilityFor({ ...identity(["owner"]), orgId: "not-a-uuid" });
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "forbidden" });
  });
});
