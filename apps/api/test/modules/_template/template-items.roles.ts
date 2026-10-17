// The roles the TemplateItems tests act as, found in @bricx/permissions'
// default bundles for this module's subject, so a copy made for another
// subject tests the same rules (pnpm new-module refuses a subject no role
// may create at project scope).
import { ROLES, ROLE_IDS, type RoleId } from "@bricx/permissions/roles";
import { SUBJECT } from "../../../src/modules/_template/template-items.policies.js";

const holds = (role: RoleId, key: string): boolean =>
  ROLES[role].some((k) => k === key);

const creator = ROLE_IDS.find((r) => holds(r, `${SUBJECT}.create.project`));
if (creator === undefined) throw new Error(`no role creates ${SUBJECT}`);

/** A role that creates and reads at project scope. */
export const CREATOR: RoleId = creator;

/** A role that reads at project scope but may not create, if one exists. */
export const READ_ONLY: RoleId | undefined = ROLE_IDS.find(
  (r) =>
    holds(r, `${SUBJECT}.read.project`) &&
    !ROLES[r].some((k) => k.startsWith(`${SUBJECT}.create.`)),
);

/** A role that reads org-wide, if one exists. */
export const ORG_READER: RoleId | undefined = ROLE_IDS.find((r) =>
  holds(r, `${SUBJECT}.read.org`),
);
