// Compile-time guarantees (P3 rule 2; ruling 1). Checked by `tsc --noEmit`
// (this package's typecheck) and by types-sabotage.test.ts, which breaks the
// sources and requires each @ts-expect-error below to become unused.
import type { OrgId, ProjectId, SiteId } from "@bricx/ids/branded";
import { buildAbility, can } from "../src/ability.ts";
import type { AbilityContext, Grant } from "../src/ability.ts";
import { CONTEXT, IN_SCOPE, PROJECT_1, SITE_1 } from "./helpers.ts";

const ability = buildAbility([], CONTEXT);

// A known action on a known subject compiles.
export const ok: boolean = can(ability, "approve", "finance.payment", IN_SCOPE);

// @ts-expect-error marker:unknown-action -- "steal" is not an action of finance.payment
can(ability, "steal", "finance.payment", IN_SCOPE);

// @ts-expect-error marker:action-of-other-subject -- "approve" is not an action of field.photo
can(ability, "approve", "field.photo", IN_SCOPE);

// @ts-expect-error marker:missing-record -- a type-only check does not compile (ruling 1)
can(ability, "approve", "finance.payment");

// @ts-expect-error marker:no-raw-can -- the handle has no CASL methods
export const rawCan: unknown = ability.can;

export const unknownPermission: Grant = {
  // @ts-expect-error marker:unknown-permission -- not in the catalogue
  permission: "finance.payment.steal",
  scope: "org",
};

// @ts-expect-error marker:project-needs-ids -- a project grant needs projectIds
export const noTargets: Grant = {
  permission: "finance.payment.approve",
  scope: "project",
};

export const wrongBrand: Grant = {
  permission: "field.photo.read",
  scope: "project",
  // @ts-expect-error marker:wrong-brand -- SiteIds are not ProjectIds
  projectIds: [SITE_1],
};

export const rightBrand: Grant = {
  permission: "field.photo.read",
  scope: "site",
  siteIds: [SITE_1 satisfies SiteId],
};

export const project: ProjectId = PROJECT_1;

export const plainContext: AbilityContext = {
  // @ts-expect-error marker:plain-org-id -- a raw string is not an OrgId
  orgId: "0190a000-0000-7000-8000-000000000001",
  userId: CONTEXT.userId,
};

export const branded: OrgId = CONTEXT.orgId;
