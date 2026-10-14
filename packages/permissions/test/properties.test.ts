// can() agrees with an independent oracle (test/oracle.ts) on random grants
// and records (fast-check).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildAbility, can } from "../src/ability.ts";
import type { Grant, PermissionRecord } from "../src/ability.ts";
import { CATALOGUE, RESOURCES } from "../src/catalogue.ts";
import type { SubjectType } from "../src/catalogue.ts";
import { oracleCan } from "./oracle.ts";
import { CONTEXT, ORG_A, ORG_B, OTHER_USER, USER, uuid } from "./helpers.ts";

const PROJECTS = [uuid(20), uuid(21), uuid(22)];
const SITES = [uuid(30), uuid(31), uuid(32)];

const grantArb = fc
  .tuple(
    fc.constantFrom(...CATALOGUE),
    fc.subarray(PROJECTS, { minLength: 1 }),
    fc.subarray(SITES, { minLength: 1 }),
  )
  .map(([key, projectIds, siteIds]): Grant => {
    const dot = key.lastIndexOf(".");
    const permission = key.slice(0, dot) as Grant["permission"];
    const scope = key.slice(dot + 1);
    if (scope === "project")
      return { permission, scope, projectIds: projectIds as never };
    if (scope === "site")
      return { permission, scope, siteIds: siteIds as never };
    return { permission, scope: scope as "org" | "own" };
  });

const recordArb = fc.record({
  orgId: fc.constantFrom(ORG_A, ORG_B),
  projectId: fc.constantFrom(...PROJECTS),
  siteId: fc.constantFrom(...SITES),
  createdBy: fc.constantFrom(USER, OTHER_USER),
});

describe("can() = oracle", () => {
  it("on 2,000 random grant sets, permissions and records", () => {
    fc.assert(
      fc.property(
        fc.array(grantArb, { maxLength: 12 }),
        fc.constantFrom(...CATALOGUE),
        recordArb,
        (grants, key, full) => {
          const withoutScope = key.slice(0, key.lastIndexOf("."));
          const dot = withoutScope.lastIndexOf(".");
          const subject = withoutScope.slice(0, dot) as SubjectType;
          const action = withoutScope.slice(dot + 1);
          const r = RESOURCES[subject];
          const record: PermissionRecord = {
            orgId: full.orgId,
            ...(r.level === "org" ? {} : { projectId: full.projectId }),
            ...(r.level === "site" ? { siteId: full.siteId } : {}),
            ...(r.createdBy ? { createdBy: full.createdBy } : {}),
          };
          const ability = buildAbility(grants, CONTEXT);
          expect(can(ability, action as never, subject, record)).toBe(
            oracleCan(grants, CONTEXT, withoutScope, record),
          );
        },
      ),
      { numRuns: 2_000, seed: 5 },
    );
  });
});
