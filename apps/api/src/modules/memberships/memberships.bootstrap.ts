// An organisation's first owner (P5-05, ADR 0066; plan 3.4, D-F): until
// P6-02 makes organisations, membership:bootstrap (the CLI) calls this
// inside one withTx() as bricx_app with the org and the new owner as the
// context (so the audit actor is the owner and RLS admits the rows).
// Refused unless the org has no membership row at all (org_not_empty);
// a users.id that does not exist is user_missing (the FK; the roles
// written before it roll back with the transaction). Writes the twelve
// roles (owner virtual: system_key alone; the other eleven bundles copied
// as open role_permissions rows, plan 3.1), the owner membership, one
// users.mfa_check outbox row (an owner holds finance keys) and one
// org.member.bootstrap audit event, last. P6-02's organisation creation
// calls this same function (for architect review).
import type { Tx } from "@bricx/db/database";
import type { UuidV7Generator } from "@bricx/ids/uuid-v7";
import { ROLE_IDS, ROLES } from "@bricx/permissions/roles";
import { memberships } from "@bricx/db/schema";
import { count, eq } from "drizzle-orm";
import { ApiError } from "../../common/errors/api-error.js";
import {
  RolesRepository,
  USERS_MFA_CHECK,
  type UsersMfaCheck,
} from "../roles/public-api.js";
import type { AuditRecorder } from "../sessions/public-api.js";
import { ORG_SUBJECT } from "./memberships.policies.js";
import type { MembershipsRepository } from "./memberships.repository.js";
import type { OutboxWriter } from "./memberships.service.js";

export type BootstrapRefusal = "org_not_empty" | "user_missing";

export class BootstrapError extends Error {
  readonly reason: BootstrapRefusal;

  constructor(reason: BootstrapRefusal) {
    super(`membership bootstrap refused: ${reason}`);
    this.reason = reason;
  }
}
Object.defineProperty(BootstrapError.prototype, "name", {
  value: "BootstrapError",
});

export interface BootstrapDeps {
  readonly roles: RolesRepository;
  readonly members: MembershipsRepository;
  readonly audit: AuditRecorder;
  readonly outbox: OutboxWriter;
  readonly ids: UuidV7Generator;
}

export interface BootstrapInput {
  readonly orgId: string;
  readonly userId: string;
  /** UTC ISO 8601. */
  readonly now: string;
}

export interface BootstrapResult {
  readonly membershipId: string;
  readonly ownerRoleId: string;
  readonly roles: number;
}

/** Writes an empty org's roles and first owner in `tx` (see the header). */
export async function bootstrapOrganization(
  tx: Tx,
  deps: BootstrapDeps,
  input: BootstrapInput,
): Promise<BootstrapResult> {
  const [existing] = await tx
    .select({ n: count() })
    .from(memberships)
    .where(eq(memberships.orgId, input.orgId));
  if ((existing?.n ?? 0) > 0) throw new BootstrapError("org_not_empty");
  let ownerRoleId: string | undefined;
  for (const key of ROLE_IDS) {
    const role = await deps.roles.insert(tx, {
      id: deps.ids.next(),
      orgId: input.orgId,
      key,
      name: key,
      now: input.now,
      systemKey: key,
    });
    if (key === "owner") {
      ownerRoleId = role.id;
      continue;
    }
    await deps.roles.grant(
      tx,
      input.orgId,
      role.id,
      ROLES[key].map((permission) => ({ id: deps.ids.next(), permission })),
      input.now,
    );
  }
  if (ownerRoleId === undefined) throw new Error("no owner role");
  let membership;
  try {
    membership = await deps.members.insertOrg(
      tx,
      {
        id: deps.ids.next(),
        orgId: input.orgId,
        userId: input.userId,
        roleId: ownerRoleId,
        now: input.now,
      },
      "owner",
    );
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") {
      throw new BootstrapError("user_missing");
    }
    throw error;
  }
  const check: UsersMfaCheck = { userId: input.userId };
  await deps.outbox.enqueue(tx, USERS_MFA_CHECK, check);
  await deps.audit.record(tx, {
    action: `${ORG_SUBJECT}.bootstrap`,
    entityType: ORG_SUBJECT,
    entityId: membership.id,
    after: {
      userId: input.userId,
      roleId: ownerRoleId,
      roles: ROLE_IDS.length,
    },
  });
  return {
    membershipId: membership.id,
    ownerRoleId,
    roles: ROLE_IDS.length,
  };
}
