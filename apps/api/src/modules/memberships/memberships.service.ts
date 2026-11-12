// Memberships' service (P5-05, ADR 0066; plan 3.2, 3.3, 3.5, 3.6, 6.2;
// owner conditions 1, 3): org memberships (a user's role in the org) and
// project memberships (a role on one project with per-member overrides).
// Each call: the identity, the policy check (403) before any database
// work, then one TxRunner transaction. Inside it, in this order:
// - the role: an open role of the org (404), its bundle (the owner's
//   from code);
// - target protection (condition 3): a change to or removal of a member
//   needs every key of that member's current role (its effective keys on
//   a project) held by the editor, at org scope for an org membership and
//   on that project for a project one (holdsAll);
// - escalation (plan 3.2): the keys granted (the new role's bundle; on a
//   project the effective keys after the overrides) must be held the same
//   way; a refusal is 403 with one grants.escalation line naming the
//   first refused key;
// - overrides (DW4): validateOverrides against the role's bundle, 422
//   validation_failed with the list's path;
// - the last owner (plan 3.3): the last open owner membership cannot be
//   demoted or removed (409), counted under the org's advisory lock;
// - the write; a removal of an org membership also closes the user's
//   project memberships in the org and their sessions there (the sessions
//   module's in-transaction revoke, cause admin, plan 6.2);
// - a removal (org) or unassignment (project) also ends the user's open
//   access grants, org-wide or that project's, revoked by the remover,
//   one org.access_grant.revoke event each (PR #71 review, amendment 2,
//   ADR 0067);
// - one users.mfa_check outbox row for the member (D5);
// - P6-06 (ADR 0077, D13, owner condition C5): no member changes or
//   assigns their own role (PATCH /members/:id, POST and PATCH of
//   project members): 403 and one deduplicated org.invitation.denied
//   event (self_role_change). Leaving (DELETE) stays allowed under the
//   last-owner rule. A removal also revokes the member's pending
//   invitations (inviter_removed, D14), one org.invitation.revoke each;
// - one audit event, the last statement (ADR 0055).
// P6-06b (ADR 0084): the member lifecycle.
// - "Active" is not removed, not suspended and not past expires_at; the
//   lists still show every open row, each with its status at the Clock.
// - suspend / reactivate / renew (org.member.update at org scope; on a
//   project project.member.assign): never on oneself (403 and one
//   deduplicated denial event, self_suspend or self_renew), and only by
//   someone holding every key of the target (holdsAll). An org suspension
//   ends the member's sessions (the sessions module's in-transaction
//   revoke), their open access grants and their pending invitations
//   (inviter_suspended) in the same transaction; a reactivation restores
//   the role, never the sessions. A project suspension mirrors a project
//   removal (owner condition C2): sessions stand, that project's grants
//   end. The last ACTIVE owner cannot be suspended, demoted or removed.
// - the suspension reason (at most 200 characters) is stored, audited and
//   answered only to a caller holding org.member.read; it is never logged
//   and never in GET /v1/me/memberships (owner condition C8, addition A3).
// - a temporary membership (expires_at) ends by itself: the grants source
//   reads active rows at the Clock. scheduleExpiry() writes the delayed
//   memberships.expire job (the record: expired_at and the audit event,
//   by the worker) and, when under 7 days are left, the one
//   memberships.expiring notice at once (C8). A renewal needs a reason,
//   moves expires_at and clears expired_at, also on an expired row.
// - an owner is never temporary and never external (409; the tables'
//   guard triggers are the backstop, SQLSTATE P606B).
// The response carries mfaRequired: requiresMfa over the member's org
// bundle and every project membership's effective keys the transaction
// can read (condition 1).
// P6-05 (ADR 0075 D15, owner condition C4): project memberships live on
// real projects. A POST or PATCH first reads the project through the
// projects module's ProjectsReader: unseen is 404, archived is 409
// (removal still works). siteIds (POST, PATCH) must all be open sites of
// the project, else 422 unknown_site at siteIds, nothing written; they
// replace the membership's assignment (none: no site keys) and appear in
// the response and the assign audit event.
import type { EndedGrant, endAccessGrantsOf } from "@bricx/db/access-grants";
import type { SettledInvitation } from "@bricx/db/invitations";
import type { Tx } from "@bricx/db/database";
import {
  type UuidV7Generator,
  createUuidV7Generator,
} from "@bricx/ids/uuid-v7";
import type { CatalogueKey } from "@bricx/permissions/catalogue";
import { requiresMfa } from "@bricx/permissions/mfa";
import {
  type OverridesProblem,
  effectiveKeys,
  knownKeys,
  validateOverrides,
} from "@bricx/permissions/overrides";
import { ROLES } from "@bricx/permissions/roles";
import { issueKey } from "@bricx/validation/codes";
import { errorEnvelope } from "@bricx/validation/error-envelope";
import { EXPIRY_NOTICE_MS, type MembershipKind } from "@bricx/db/memberships";
import { MAX_DELAY_MS } from "@bricx/db/outbox";
import { type Ability, can } from "@bricx/permissions/ability";
import { Inject, Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { holdsAll } from "../../common/auth/holds.js";
import { CLOCK, type Clock } from "../../common/clock.js";
import type { Identity } from "../../common/db/request-context.js";
import {
  INVITATION_REVOKER,
  INVITATION_SUBJECT,
  type InvitationRevoker,
} from "../../common/db/invitation-revoker.js";
import { TxRunner } from "../../common/db/tx-runner.js";
import { ApiError, ValidationError } from "../../common/errors/api-error.js";
import {
  AuditService,
  type DeniedReason,
  DenialRecorder,
} from "../audit/public-api.js";
import { OutboxService } from "../outbox/public-api.js";
import { ProjectsReader } from "../projects/public-api.js";
import {
  type RoleRow,
  RolesRepository,
  USERS_MFA_CHECK,
  type UsersMfaCheck,
} from "../roles/public-api.js";
import {
  type AuditRecorder,
  SessionsService,
  type TransactionRunner,
  requireIdentity,
} from "../sessions/public-api.js";
import {
  MAX_MEMBERSHIP_MS,
  MIN_MEMBERSHIP_MS,
  type MemberData,
  type MemberStatus,
  type MyMembershipData,
  type OverridesInput,
  type ProjectMemberData,
} from "./memberships.dto.js";
import {
  MEMBERSHIPS_EXPIRE,
  MEMBERSHIPS_EXPIRING,
  type MembershipsExpire,
  type MembershipsExpiring,
} from "./memberships.events.js";
import {
  ACCESS_GRANT_SUBJECT,
  ORG_SUBJECT,
  PROJECT_SUBJECT,
  assertCanOrg,
  assertCanProject,
} from "./memberships.policies.js";
import {
  type Lifecycle,
  type MembershipRow,
  MembershipsRepository,
  type ProjectMembershipRow,
  type StoredOverrides,
} from "./memberships.repository.js";

export type OutboxWriter = Pick<OutboxService, "enqueue">;
/**
 * Ends a removed member's open elevations (P5-07, rule 13): the module
 * provides @bricx/db/access-grants' endAccessGrantsOf, so this module
 * never writes the access-grants module's table itself.
 */
export type AccessGrantEnder = typeof endAccessGrantsOf;
export const ACCESS_GRANT_ENDER = Symbol("ACCESS_GRANT_ENDER");
export type SessionsRevoker = Pick<SessionsService, "revokeOfUserInTx">;
export type Denials = Pick<DenialRecorder, "record">;
/** The project's state and open sites (P6-05; a fake in the unit tests). */
export type ProjectStates = Pick<ProjectsReader, "stateOf" | "openSiteIds">;

/** What the controllers call. */
export type MembershipsPort = Pick<
  MembershipsService,
  | "list"
  | "update"
  | "remove"
  | "listProject"
  | "assign"
  | "updateProject"
  | "unassign"
  | "listMine"
  | "suspend"
  | "reactivate"
  | "renew"
  | "suspendProject"
  | "reactivateProject"
  | "renewProject"
>;

/** A suspension, as sent. */
export interface SuspendInput {
  readonly reason: string;
}

/** A renewal, as sent. */
export interface RenewInput {
  readonly expiresAt: string;
  readonly reason: string;
}

/**
 * A membership's status at `nowMs` (P6-06b, ADR 0084): suspended wins
 * over expired; a temporary one is expired from expires_at on (the
 * grants source's `at < expires_at`, the same boundary).
 */
export function statusOf(
  row: Pick<Lifecycle, "suspendedAt" | "expiresAt">,
  nowMs: number,
): MemberStatus {
  if (row.suspendedAt !== null) return "suspended";
  if (row.expiresAt !== null && nowMs >= Date.parse(row.expiresAt)) {
    return "expired";
  }
  return "active";
}

/** Both override lists, sorted and unique: the stored and the answered form. */
export interface NormalOverrides {
  readonly add: string[];
  readonly remove: string[];
}

const sorted = (keys: Iterable<string>): string[] => [...new Set(keys)].sort();

/** The strings of a stored list (anything else is dropped). */
const stringsOf = (value: readonly unknown[] | undefined): string[] =>
  (value ?? []).filter((entry): entry is string => typeof entry === "string");

/** Overrides as stored or as sent, normalised. */
export function normalOverrides(
  overrides: StoredOverrides | OverridesInput | undefined,
): NormalOverrides {
  return {
    add: sorted(stringsOf(overrides?.add)),
    remove: sorted(stringsOf(overrides?.remove)),
  };
}

const sameOverrides = (a: NormalOverrides, b: NormalOverrides): boolean =>
  a.add.length === b.add.length &&
  a.remove.length === b.remove.length &&
  a.add.every((key, i) => key === b.add[i]) &&
  a.remove.every((key, i) => key === b.remove[i]);

/** What one user holds in the org, for the MFA rule. */
export interface MfaInput {
  /** The org role's bundle, or undefined without an org membership. */
  readonly org: readonly string[] | undefined;
  readonly projects: readonly {
    readonly bundle: readonly string[];
    readonly overrides: StoredOverrides | NormalOverrides;
  }[];
}

/** requiresMfa over the org bundle and every project's effective keys (condition 1). */
export function mfaRequiredOf(input: MfaInput): boolean {
  const keys = new Set<string>(knownKeys(input.org ?? []).known);
  for (const project of input.projects) {
    for (const key of effectiveKeys(
      project.bundle,
      normalOverrides(project.overrides),
    )) {
      keys.add(key);
    }
  }
  return requiresMfa([...keys]);
}

/** The path of the override list an OverridesProblem names. */
const problemPath = (problem: OverridesProblem): string[] => {
  switch (problem) {
    case "remove_not_in_bundle":
    case "key_in_both":
      return ["overrides", "remove"];
    case "too_many_keys":
    case "bundle_immutable":
      return ["overrides"];
    default:
      return ["overrides", "add"];
  }
};

/** A change of the caller's own membership found inside a transaction (C5; P6-06b). */
class SelfChange extends Error {
  constructor(
    readonly entityId: string,
    readonly entityType: string,
    readonly reason: DeniedReason = "self_role_change",
  ) {
    super("self change");
  }
}

/** What a caller may see of a member's lifecycle (owner addition A3). */
interface View {
  readonly nowMs: number;
  /** The caller holds org.member.read: the suspension reason is answered. */
  readonly reason: boolean;
}

/** A role with its bundle, as read in the transaction. */
interface RoleBundle {
  readonly row: RoleRow;
  readonly keys: readonly CatalogueKey[];
}

@Injectable()
export class MembershipsService {
  private readonly ids: UuidV7Generator;

  constructor(
    @Inject(TxRunner) private readonly runner: TransactionRunner,
    @Inject(MembershipsRepository)
    private readonly repository: MembershipsRepository,
    @Inject(RolesRepository) private readonly roles: RolesRepository,
    @Inject(AuditService) private readonly audit: AuditRecorder,
    @Inject(OutboxService) private readonly outbox: OutboxWriter,
    @Inject(SessionsService) private readonly sessions: SessionsRevoker,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
    @Inject(ACCESS_GRANT_ENDER) private readonly endGrants: AccessGrantEnder,
    @Inject(ProjectsReader) private readonly projects: ProjectStates,
    @Inject(INVITATION_REVOKER)
    private readonly revokeInvitations: InvitationRevoker,
    @Inject(DenialRecorder) private readonly denials: Denials,
  ) {
    this.ids = createUuidV7Generator({ clock });
    this.logger.setContext("memberships");
  }

  private now(): string {
    return new Date(this.clock.now()).toISOString();
  }

  /** The open keys of a role: the virtual owner bundle, else its open rows. */
  private async bundleOf(
    tx: Tx,
    orgId: string,
    roleId: string,
    systemKey: string | null,
  ): Promise<readonly CatalogueKey[]> {
    if (systemKey === "owner") return ROLES.owner;
    const bundles = await this.roles.bundles(tx, orgId, [roleId]);
    return knownKeys(bundles.get(roleId) ?? []).known;
  }

  /** The org's open role `id` with its bundle (404 otherwise). */
  private async roleOf(tx: Tx, orgId: string, id: string): Promise<RoleBundle> {
    const row = await this.roles.findOpen(tx, orgId, id);
    if (row === undefined) throw new ApiError("not_found");
    return { row, keys: await this.bundleOf(tx, orgId, row.id, row.systemKey) };
  }

  /** The first key of `keys` the editor does not hold: 403, logged. */
  private refuse(
    identity: Identity,
    ability: ReturnType<typeof assertCanOrg>,
    keys: readonly string[],
    projectId?: string,
  ): void {
    const refused = holdsAll(ability, identity.orgId, keys, projectId);
    if (refused === undefined) return;
    this.logger.warn(
      {
        userId: identity.userId,
        orgId: identity.orgId,
        key: refused,
        ...(projectId === undefined ? {} : { projectId }),
      },
      "grants.escalation",
    );
    throw new ApiError("forbidden");
  }

  /**
   * The self-change guard (P6-06, ADR 0077, D13; owner condition C5): no
   * member changes or assigns their own role, owners included (an owner
   * steps down only by another owner's change). Leaving (DELETE of one's
   * own membership) is not a role change and stays allowed, under the
   * last-owner rule. A refusal is 403 and one deduplicated
   * org.invitation.denied event (reason self_role_change, D17, C8),
   * written before any database work.
   */
  private async refuseSelf(
    identity: Identity,
    targetUserId: string,
    entityId: string,
    entityType: string,
    reason: DeniedReason = "self_role_change",
  ): Promise<void> {
    if (targetUserId !== identity.userId) return;
    this.logger.warn(
      { userId: identity.userId, orgId: identity.orgId },
      "grants.self_change",
    );
    await this.denials.record({
      orgId: identity.orgId,
      actorId: identity.userId,
      reason,
      entityId,
      entityType,
    });
    throw new ApiError("forbidden");
  }

  /** One org.invitation.revoke event per invitation a cascade revoked (D14). */
  private async recordRevokedInvitations(
    tx: Tx,
    revoked: readonly SettledInvitation[],
  ): Promise<void> {
    for (const invitation of revoked) {
      await this.audit.record(tx, {
        action: `${INVITATION_SUBJECT}.revoke`,
        entityType: INVITATION_SUBJECT,
        entityId: invitation.id,
        before: { status: "pending", projectId: invitation.projectId },
        after: {
          status: "revoked",
          projectId: invitation.projectId,
          reason: invitation.revokeReason,
        },
      });
    }
  }

  /** The MFA requirement of each of `userIds` from the org-scoped rows. */
  private async mfaOf(
    tx: Tx,
    orgId: string,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, boolean>> {
    const rows = await this.repository.accessRowsOf(tx, orgId, userIds);
    const roleIds = sorted(
      [...rows.memberships, ...rows.projects]
        .filter((row) => row.systemKey !== "owner")
        .map((row) => row.roleId),
    );
    const bundles =
      roleIds.length === 0
        ? new Map<string, readonly string[]>()
        : await this.roles.bundles(tx, orgId, roleIds);
    const keysOf = (row: MembershipRow): readonly string[] =>
      row.systemKey === "owner" ? ROLES.owner : (bundles.get(row.roleId) ?? []);
    const out = new Map<string, boolean>();
    for (const userId of userIds) {
      const membership = rows.memberships.find((row) => row.userId === userId);
      out.set(
        userId,
        mfaRequiredOf({
          org: membership === undefined ? undefined : keysOf(membership),
          projects: rows.projects
            .filter((row) => row.userId === userId)
            .map((row) => ({ bundle: keysOf(row), overrides: row.overrides })),
        }),
      );
    }
    return out;
  }

  /** What `identity` sees at the Clock (A3: the reason needs org.member.read). */
  private viewOf(identity: Identity, ability: Ability): View {
    return {
      nowMs: this.clock.now(),
      reason: can(ability, "read", ORG_SUBJECT, { orgId: identity.orgId }),
    };
  }

  private static lifecycle(row: Lifecycle, view: View) {
    return {
      status: statusOf(row, view.nowMs),
      suspendedAt: row.suspendedAt,
      suspendReason: view.reason ? row.suspendReason : null,
      expiresAt: row.expiresAt,
      external: row.external,
    };
  }

  private static member(
    row: MembershipRow,
    mfaRequired: boolean,
    view: View,
  ): MemberData {
    return {
      id: row.id,
      userId: row.userId,
      roleId: row.roleId,
      createdAt: row.createdAt,
      removedAt: row.removedAt,
      mfaRequired,
      ...MembershipsService.lifecycle(row, view),
    };
  }

  private static projectMember(
    row: ProjectMembershipRow,
    mfaRequired: boolean,
    view: View,
  ): ProjectMemberData {
    return {
      id: row.id,
      projectId: row.projectId,
      userId: row.userId,
      roleId: row.roleId,
      overrides: normalOverrides(row.overrides),
      siteIds: [...row.siteIds].sort(),
      createdAt: row.createdAt,
      removedAt: row.removedAt,
      mfaRequired,
      ...MembershipsService.lifecycle(row, view),
    };
  }

  private async presentMember(
    tx: Tx,
    orgId: string,
    row: MembershipRow,
    view: View,
  ): Promise<MemberData> {
    const mfa = await this.mfaOf(tx, orgId, [row.userId]);
    return MembershipsService.member(row, mfa.get(row.userId) === true, view);
  }

  private async presentProjectMember(
    tx: Tx,
    orgId: string,
    row: ProjectMembershipRow,
    view: View,
  ): Promise<ProjectMemberData> {
    const mfa = await this.mfaOf(tx, orgId, [row.userId]);
    return MembershipsService.projectMember(
      row,
      mfa.get(row.userId) === true,
      view,
    );
  }

  /** One org.access_grant.revoke event per grant a removal ended. */
  private async recordEndedGrants(
    tx: Tx,
    ended: readonly EndedGrant[],
    cause: string,
  ): Promise<void> {
    for (const grant of ended) {
      await this.audit.record(tx, {
        action: `${ACCESS_GRANT_SUBJECT}.revoke`,
        entityType: ACCESS_GRANT_SUBJECT,
        entityId: grant.id,
        before: { revokedAt: null, revokedBy: null },
        after: {
          revokedAt: grant.revokedAt,
          revokedBy: grant.revokedBy,
          cause,
        },
      });
    }
  }

  private async enqueueMfaCheck(tx: Tx, userId: string): Promise<void> {
    const check: UsersMfaCheck = { userId };
    await this.outbox.enqueue(tx, USERS_MFA_CHECK, check);
  }

  /**
   * 409 unless another ACTIVE owner membership remains (under the org
   * lock; P6-06b: a suspended owner does not count).
   */
  private async assertNotLastOwner(tx: Tx, orgId: string): Promise<void> {
    await this.repository.lockOrg(tx, orgId);
    if ((await this.repository.countActiveOwners(tx, orgId)) <= 1) {
      throw new ApiError("request.conflict");
    }
  }

  /**
   * The org's open memberships (org.member.read.org), each with its
   * status; with `expiringWithinDays` only the temporary ones ending
   * within that many days of the Clock (the owner's "expiring soon" list).
   */
  async list(
    query: { readonly expiringWithinDays?: number | undefined } = {},
  ): Promise<MemberData[]> {
    const identity = requireIdentity();
    const view = this.viewOf(identity, assertCanOrg(identity, "read"));
    const days = query.expiringWithinDays;
    return this.runner.run(async (tx) => {
      const rows = await this.repository.listOrg(
        tx,
        identity.orgId,
        days === undefined
          ? undefined
          : {
              from: new Date(view.nowMs).toISOString(),
              until: new Date(view.nowMs + days * 86_400_000).toISOString(),
            },
      );
      const mfa = await this.mfaOf(
        tx,
        identity.orgId,
        sorted(rows.map((row) => row.userId)),
      );
      return rows.map((row) =>
        MembershipsService.member(row, mfa.get(row.userId) === true, view),
      );
    });
  }

  /** A new role on an org membership (org.member.update.org). */
  update(id: string, input: { readonly roleId: string }): Promise<MemberData> {
    const identity = requireIdentity();
    const ability = assertCanOrg(identity, "update");
    return this.guardSelf(identity, () =>
      this.updateIn(identity, ability, id, input),
    );
  }

  /** Runs `work`; a SelfChange it throws becomes the C5 refusal, after its rollback. */
  private async guardSelf<T>(
    identity: Identity,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof SelfChange)) throw error;
      await this.refuseSelf(
        identity,
        identity.userId,
        error.entityId,
        error.entityType,
        error.reason,
      );
      throw error;
    }
  }

  private updateIn(
    identity: Identity,
    ability: ReturnType<typeof assertCanOrg>,
    id: string,
    input: { readonly roleId: string },
  ): Promise<MemberData> {
    return this.runner.run(async (tx) => {
      const row = await this.repository.findOrg(tx, identity.orgId, id);
      if (row === undefined) throw new ApiError("not_found");
      if (row.userId === identity.userId) throw new SelfChange(id, ORG_SUBJECT);
      const current = await this.bundleOf(
        tx,
        identity.orgId,
        row.roleId,
        row.systemKey,
      );
      this.refuse(identity, ability, current);
      const view = this.viewOf(identity, ability);
      if (input.roleId === row.roleId) {
        return this.presentMember(tx, identity.orgId, row, view);
      }
      const role = await this.roleOf(tx, identity.orgId, input.roleId);
      this.refuse(identity, ability, role.keys);
      // P6-06b (owner addition A2): a temporary or external member is
      // never promoted to owner (the guard trigger is the backstop).
      if (
        role.row.systemKey === "owner" &&
        (row.expiresAt !== null || row.external)
      ) {
        throw new ApiError("request.conflict");
      }
      if (
        row.systemKey === "owner" &&
        row.suspendedAt === null &&
        role.row.systemKey !== "owner"
      ) {
        await this.assertNotLastOwner(tx, identity.orgId);
      }
      const updated = await this.repository.setOrgRole(
        tx,
        identity.orgId,
        id,
        role.row.id,
        role.row.systemKey,
      );
      const member = await this.presentMember(
        tx,
        identity.orgId,
        updated,
        view,
      );
      await this.enqueueMfaCheck(tx, row.userId);
      await this.audit.record(tx, {
        action: `${ORG_SUBJECT}.update`,
        entityType: ORG_SUBJECT,
        entityId: id,
        before: { userId: row.userId, roleId: row.roleId },
        after: { userId: row.userId, roleId: updated.roleId },
      });
      return member;
    });
  }

  /**
   * Removes an org membership (org.member.remove.org): the user's project
   * memberships in the org close, their open access grants there end,
   * their sessions there are revoked (cause admin), then the audit events.
   */
  remove(id: string): Promise<void> {
    const identity = requireIdentity();
    const ability = assertCanOrg(identity, "remove");
    return this.runner.run(async (tx) => {
      const row = await this.repository.findOrg(tx, identity.orgId, id);
      if (row === undefined) throw new ApiError("not_found");
      const current = await this.bundleOf(
        tx,
        identity.orgId,
        row.roleId,
        row.systemKey,
      );
      this.refuse(identity, ability, current);
      if (row.systemKey === "owner" && row.suspendedAt === null) {
        await this.assertNotLastOwner(tx, identity.orgId);
      }
      const now = this.now();
      const projectsClosed = await this.repository.removeProjectsOfUser(
        tx,
        identity.orgId,
        row.userId,
        now,
      );
      const removed = await this.repository.removeOrg(
        tx,
        identity.orgId,
        id,
        now,
      );
      if (removed === undefined) throw new ApiError("not_found");
      const grantsEnded = await this.endGrants(
        tx,
        identity.orgId,
        row.userId,
        identity.userId,
        now,
      );
      const sessions = await this.sessions.revokeOfUserInTx(
        tx,
        identity,
        row.userId,
      );
      // P6-06 (ADR 0077, D14, S10): the removed member's pending
      // invitations die with the membership, in this transaction.
      const invitationsRevoked = await this.revokeInvitations(tx, {
        orgId: identity.orgId,
        scope: { invitedBy: row.userId },
        reason: "inviter_removed",
        by: identity.userId,
        now,
      });
      await this.enqueueMfaCheck(tx, row.userId);
      await this.recordEndedGrants(tx, grantsEnded, `${ORG_SUBJECT}.remove`);
      await this.recordRevokedInvitations(tx, invitationsRevoked);
      await this.audit.record(tx, {
        action: `${ORG_SUBJECT}.remove`,
        entityType: ORG_SUBJECT,
        entityId: id,
        before: { userId: row.userId, roleId: row.roleId },
        after: {
          projectMembershipsClosed: projectsClosed,
          sessionsClosed: sessions.length,
          accessGrantsRevoked: grantsEnded.length,
          invitationsRevoked: invitationsRevoked.length,
        },
      });
    });
  }

  /** The project's open memberships (project.member.read at org or that project). */
  async listProject(projectId: string): Promise<ProjectMemberData[]> {
    const identity = requireIdentity();
    const view = this.viewOf(
      identity,
      assertCanProject(identity, "read", projectId),
    );
    return this.runner.run(async (tx) => {
      const rows = await this.repository.listProject(
        tx,
        identity.orgId,
        projectId,
      );
      const mfa = await this.mfaOf(
        tx,
        identity.orgId,
        sorted(rows.map((row) => row.userId)),
      );
      return rows.map((row) =>
        MembershipsService.projectMember(
          row,
          mfa.get(row.userId) === true,
          view,
        ),
      );
    });
  }

  /** The overrides checked against the bundle (422) and the effective keys. */
  private effectiveOf(
    role: RoleBundle,
    overrides: NormalOverrides,
  ): readonly CatalogueKey[] {
    const problem = validateOverrides(overrides, role.keys, {
      immutable: role.row.systemKey === "owner",
    });
    if (problem !== undefined) {
      throw new ValidationError({
        ...errorEnvelope("validation_failed"),
        issues: [
          {
            path: problemPath(problem),
            code: "invalid_value",
            key: "validation:invalid_value",
          },
        ],
      });
    }
    return effectiveKeys(role.keys, overrides);
  }

  /** 404 unless the transaction sees the project; 409 when it is archived (C4). */
  private async assertOpenProject(
    tx: Tx,
    orgId: string,
    projectId: string,
  ): Promise<void> {
    const state = await this.projects.stateOf(tx, orgId, projectId);
    if (state === undefined) throw new ApiError("not_found");
    if (state.status === "archived") throw new ApiError("request.conflict");
  }

  /** `siteIds`, sorted, after checking each is an open site of the project (422 unknown_site). */
  private async openSites(
    tx: Tx,
    orgId: string,
    projectId: string,
    siteIds: readonly string[],
  ): Promise<string[]> {
    const wanted = sorted(siteIds);
    if (wanted.length === 0) return [];
    const open = await this.projects.openSiteIds(tx, orgId, projectId, wanted);
    if (
      open.length !== wanted.length ||
      wanted.some((id) => !open.includes(id))
    ) {
      throw new ValidationError({
        ...errorEnvelope("validation_failed"),
        issues: [
          {
            path: ["siteIds"],
            code: "unknown_site",
            key: issueKey("unknown_site"),
          },
        ],
      });
    }
    return wanted;
  }

  /** A new project membership (project.member.assign; the user must be an org member). */
  assign(
    projectId: string,
    input: {
      readonly userId: string;
      readonly roleId: string;
      readonly overrides?: OverridesInput | undefined;
      readonly siteIds?: readonly string[] | undefined;
      readonly expiresAt?: string | undefined;
    },
  ): Promise<ProjectMemberData> {
    const identity = requireIdentity();
    const ability = assertCanProject(identity, "assign", projectId);
    // C5: no one assigns themselves to a project (the target is known
    // before any database work).
    return this.guardSelf(identity, () => {
      if (input.userId === identity.userId) {
        throw new SelfChange(projectId, PROJECT_SUBJECT);
      }
      return this.assignIn(identity, ability, projectId, input);
    });
  }

  private assignIn(
    identity: Identity,
    ability: ReturnType<typeof assertCanProject>,
    projectId: string,
    input: {
      readonly userId: string;
      readonly roleId: string;
      readonly overrides?: OverridesInput | undefined;
      readonly siteIds?: readonly string[] | undefined;
      readonly expiresAt?: string | undefined;
    },
  ): Promise<ProjectMemberData> {
    return this.runner.run(async (tx) => {
      await this.assertOpenProject(tx, identity.orgId, projectId);
      const role = await this.roleOf(tx, identity.orgId, input.roleId);
      const overrides = normalOverrides(input.overrides);
      const keys = this.effectiveOf(role, overrides);
      this.refuse(identity, ability, keys, projectId);
      const access = await this.repository.accessRowsOf(tx, identity.orgId, [
        input.userId,
      ]);
      const [orgRow] = access.memberships;
      if (orgRow === undefined) {
        throw new ApiError("request.conflict");
      }
      const now = this.now();
      const expiresAt = input.expiresAt ?? null;
      if (expiresAt !== null) {
        this.assertEnd(expiresAt);
        // An owner-role project membership is never temporary (the guard
        // trigger is the backstop).
        if (role.row.systemKey === "owner") {
          throw new ApiError("request.conflict");
        }
      }
      // Nor is it held by an external member.
      if (role.row.systemKey === "owner" && orgRow.external) {
        throw new ApiError("request.conflict");
      }
      const siteIds = await this.openSites(
        tx,
        identity.orgId,
        projectId,
        input.siteIds ?? [],
      );
      const inserted = {
        ...(await this.repository.insertProject(
          tx,
          {
            id: this.ids.next(),
            orgId: identity.orgId,
            projectId,
            userId: input.userId,
            roleId: role.row.id,
            overrides,
            now,
            expiresAt,
          },
          role.row.systemKey,
        )),
        external: orgRow.external,
      };
      const row =
        siteIds.length === 0
          ? inserted
          : {
              ...inserted,
              siteIds: await this.repository.setSites(tx, {
                orgId: identity.orgId,
                projectId,
                membershipId: inserted.id,
                userId: inserted.userId,
                siteIds,
                now,
                nextId: () => this.ids.next(),
              }),
            };
      const member = await this.presentProjectMember(
        tx,
        identity.orgId,
        row,
        this.viewOf(identity, ability),
      );
      if (expiresAt !== null) {
        await this.scheduleExpiry(tx, {
          kind: "project",
          orgId: identity.orgId,
          id: row.id,
          userId: row.userId,
          expiresAt,
        });
      }
      await this.enqueueMfaCheck(tx, input.userId);
      await this.audit.record(tx, {
        action: `${PROJECT_SUBJECT}.assign`,
        entityType: PROJECT_SUBJECT,
        entityId: row.id,
        after: {
          userId: row.userId,
          projectId: row.projectId,
          roleId: row.roleId,
          overrides,
          siteIds,
          ...(expiresAt === null ? {} : { expiresAt }),
        },
      });
      return member;
    });
  }

  /** A new role, overrides and/or sites on a project membership (project.member.assign). */
  updateProject(
    projectId: string,
    id: string,
    input: {
      readonly roleId?: string | undefined;
      readonly overrides?: OverridesInput | undefined;
      readonly siteIds?: readonly string[] | undefined;
    },
  ): Promise<ProjectMemberData> {
    const identity = requireIdentity();
    const ability = assertCanProject(identity, "assign", projectId);
    return this.guardSelf(identity, () =>
      this.updateProjectIn(identity, ability, projectId, id, input),
    );
  }

  private updateProjectIn(
    identity: Identity,
    ability: ReturnType<typeof assertCanProject>,
    projectId: string,
    id: string,
    input: {
      readonly roleId?: string | undefined;
      readonly overrides?: OverridesInput | undefined;
      readonly siteIds?: readonly string[] | undefined;
    },
  ): Promise<ProjectMemberData> {
    return this.runner.run(async (tx) => {
      await this.assertOpenProject(tx, identity.orgId, projectId);
      const row = await this.repository.findProject(
        tx,
        identity.orgId,
        projectId,
        id,
      );
      if (row === undefined) throw new ApiError("not_found");
      if (row.userId === identity.userId) {
        throw new SelfChange(id, PROJECT_SUBJECT);
      }
      const before = normalOverrides(row.overrides);
      const currentKeys = effectiveKeys(
        await this.bundleOf(tx, identity.orgId, row.roleId, row.systemKey),
        before,
      );
      this.refuse(identity, ability, currentKeys, projectId);
      const role = await this.roleOf(
        tx,
        identity.orgId,
        input.roleId ?? row.roleId,
      );
      const overrides =
        input.overrides === undefined
          ? before
          : normalOverrides(input.overrides);
      const keys = this.effectiveOf(role, overrides);
      this.refuse(identity, ability, keys, projectId);
      const siteIds =
        input.siteIds === undefined
          ? [...row.siteIds]
          : await this.openSites(tx, identity.orgId, projectId, input.siteIds);
      const sitesChanged = siteIds.join(",") !== [...row.siteIds].join(",");
      const grantChanged =
        role.row.id !== row.roleId || !sameOverrides(before, overrides);
      const view = this.viewOf(identity, ability);
      if (!grantChanged && !sitesChanged) {
        return this.presentProjectMember(tx, identity.orgId, row, view);
      }
      // P6-06b: no promotion of a temporary or external member's project
      // row to the owner role (the guard trigger is the backstop).
      if (
        role.row.systemKey === "owner" &&
        (row.expiresAt !== null || row.external)
      ) {
        throw new ApiError("request.conflict");
      }
      const changed = grantChanged
        ? await this.repository.updateProject(tx, identity.orgId, id, {
            roleId: role.row.id,
            systemKey: role.row.systemKey,
            overrides,
          })
        : row;
      const updated = sitesChanged
        ? {
            ...changed,
            siteIds: await this.repository.setSites(tx, {
              orgId: identity.orgId,
              projectId,
              membershipId: id,
              userId: row.userId,
              siteIds,
              now: this.now(),
              nextId: () => this.ids.next(),
            }),
          }
        : changed;
      const member = await this.presentProjectMember(
        tx,
        identity.orgId,
        updated,
        view,
      );
      await this.enqueueMfaCheck(tx, row.userId);
      await this.audit.record(tx, {
        action: `${PROJECT_SUBJECT}.assign`,
        entityType: PROJECT_SUBJECT,
        entityId: id,
        before: {
          userId: row.userId,
          projectId: row.projectId,
          roleId: row.roleId,
          overrides: before,
          siteIds: [...row.siteIds],
        },
        after: {
          userId: row.userId,
          projectId: row.projectId,
          roleId: updated.roleId,
          overrides,
          siteIds,
        },
      });
      return member;
    });
  }

  /**
   * Removes a project membership (project.member.assign); sessions stand,
   * the user's open access grants on that project end.
   */
  unassign(projectId: string, id: string): Promise<void> {
    const identity = requireIdentity();
    const ability = assertCanProject(identity, "assign", projectId);
    return this.runner.run(async (tx) => {
      const row = await this.repository.findProject(
        tx,
        identity.orgId,
        projectId,
        id,
      );
      if (row === undefined) throw new ApiError("not_found");
      const before = normalOverrides(row.overrides);
      const currentKeys = effectiveKeys(
        await this.bundleOf(tx, identity.orgId, row.roleId, row.systemKey),
        before,
      );
      this.refuse(identity, ability, currentKeys, projectId);
      const now = this.now();
      const removed = await this.repository.removeProject(
        tx,
        identity.orgId,
        id,
        now,
      );
      if (removed === undefined) throw new ApiError("not_found");
      const grantsEnded = await this.endGrants(
        tx,
        identity.orgId,
        row.userId,
        identity.userId,
        now,
        projectId,
      );
      await this.enqueueMfaCheck(tx, row.userId);
      await this.recordEndedGrants(
        tx,
        grantsEnded,
        `${PROJECT_SUBJECT}.unassign`,
      );
      await this.audit.record(tx, {
        action: `${PROJECT_SUBJECT}.unassign`,
        entityType: PROJECT_SUBJECT,
        entityId: id,
        before: {
          userId: row.userId,
          projectId: row.projectId,
          roleId: row.roleId,
          overrides: before,
        },
        after: { accessGrantsRevoked: grantsEnded.length },
      });
    });
  }

  /** 422 at expiresAt unless it is 1 hour to 366 days after the Clock (Q6). */
  private assertEnd(expiresAt: string): void {
    const left = Date.parse(expiresAt) - this.clock.now();
    if (left >= MIN_MEMBERSHIP_MS && left <= MAX_MEMBERSHIP_MS) return;
    throw new ValidationError({
      ...errorEnvelope("validation_failed"),
      issues: [
        {
          path: ["expiresAt"],
          code: "invalid_value",
          key: "validation:invalid_value",
        },
      ],
    });
  }

  /**
   * What a new end on a temporary membership writes besides the row, in
   * the same transaction (rule 5): the delayed memberships.expire job
   * when the end is within BullMQ's longest delay (the sweep records the
   * others), and the memberships.expiring notice at once when under 7
   * days are left (owner condition C8), marking the row so the sweep
   * writes no second one. Also called by the invitations module at accept.
   */
  async scheduleExpiry(
    tx: Tx,
    input: {
      readonly kind: MembershipKind;
      readonly orgId: string;
      readonly id: string;
      readonly userId: string;
      readonly expiresAt: string;
    },
  ): Promise<void> {
    const left = Date.parse(input.expiresAt) - this.clock.now();
    if (left <= MAX_DELAY_MS) {
      const expire: MembershipsExpire = {
        kind: input.kind,
        membershipId: input.id,
        userId: input.userId,
        expiresAt: input.expiresAt,
      };
      await this.outbox.enqueue(tx, MEMBERSHIPS_EXPIRE, expire, {
        notBefore: input.expiresAt,
      });
    }
    if (left < EXPIRY_NOTICE_MS) {
      await this.repository.markNotified(
        tx,
        input.orgId,
        input.kind,
        input.id,
        this.now(),
      );
      const notice: MembershipsExpiring = {
        kind: input.kind,
        membershipId: input.id,
        userId: input.userId,
      };
      await this.outbox.enqueue(tx, MEMBERSHIPS_EXPIRING, notice);
    }
  }

  /** The org's open membership `id` under the org lock, checked: 404, self, holdsAll. */
  private async targetOrg(
    tx: Tx,
    identity: Identity,
    ability: Ability,
    id: string,
    self: DeniedReason,
  ): Promise<MembershipRow> {
    await this.repository.lockOrg(tx, identity.orgId);
    const row = await this.repository.findOrg(tx, identity.orgId, id);
    if (row === undefined) throw new ApiError("not_found");
    if (row.userId === identity.userId) {
      throw new SelfChange(id, ORG_SUBJECT, self);
    }
    this.refuse(
      identity,
      ability,
      await this.bundleOf(tx, identity.orgId, row.roleId, row.systemKey),
    );
    return row;
  }

  /** The row again after a write (404 when it went). */
  private async reread(
    tx: Tx,
    identity: Identity,
    ability: Ability,
    id: string,
  ): Promise<MemberData> {
    const row = await this.repository.findOrg(tx, identity.orgId, id);
    if (row === undefined) throw new ApiError("not_found");
    return this.presentMember(
      tx,
      identity.orgId,
      row,
      this.viewOf(identity, ability),
    );
  }

  /**
   * Suspends an org membership (org.member.update.org; P6-06b, ADR 0084):
   * never oneself, never the last active owner, only with every key of
   * the target. In the same transaction the member's sessions in the org
   * close (cause admin), their open access grants end and their pending
   * invitations are revoked (inviter_suspended). The membership and its
   * project rows stay: the grants source stops reading them, so the next
   * request of that user is 403. An already suspended one is 409.
   */
  suspend(id: string, input: SuspendInput): Promise<MemberData> {
    const identity = requireIdentity();
    const ability = assertCanOrg(identity, "update");
    return this.guardSelf(identity, () =>
      this.runner.run(async (tx) => {
        const row = await this.targetOrg(
          tx,
          identity,
          ability,
          id,
          "self_suspend",
        );
        if (row.suspendedAt !== null) throw new ApiError("request.conflict");
        if (
          row.systemKey === "owner" &&
          (await this.repository.countActiveOwners(tx, identity.orgId)) <= 1
        ) {
          throw new ApiError("request.conflict");
        }
        const now = this.now();
        const suspended = await this.repository.suspendOrg(
          tx,
          identity.orgId,
          id,
          { by: identity.userId, reason: input.reason, now },
        );
        if (suspended === undefined) throw new ApiError("request.conflict");
        const grantsEnded = await this.endGrants(
          tx,
          identity.orgId,
          row.userId,
          identity.userId,
          now,
        );
        const sessions = await this.sessions.revokeOfUserInTx(
          tx,
          identity,
          row.userId,
        );
        const invitationsRevoked = await this.revokeInvitations(tx, {
          orgId: identity.orgId,
          scope: { invitedBy: row.userId },
          reason: "inviter_suspended",
          by: identity.userId,
          now,
        });
        const member = await this.reread(tx, identity, ability, id);
        await this.enqueueMfaCheck(tx, row.userId);
        await this.recordEndedGrants(tx, grantsEnded, `${ORG_SUBJECT}.suspend`);
        await this.recordRevokedInvitations(tx, invitationsRevoked);
        await this.audit.record(tx, {
          action: `${ORG_SUBJECT}.suspend`,
          entityType: ORG_SUBJECT,
          entityId: id,
          before: { userId: row.userId, roleId: row.roleId, suspendedAt: null },
          after: {
            suspendedAt: now,
            suspendedBy: identity.userId,
            reason: input.reason,
            external: row.external,
            sessionsClosed: sessions.length,
            accessGrantsRevoked: grantsEnded.length,
            invitationsRevoked: invitationsRevoked.length,
          },
        });
        return member;
      }),
    );
  }

  /**
   * Ends a suspension (org.member.update.org): the role and the project
   * rows count again from the next request; no session comes back (the
   * member signs in again). A membership that is not suspended is 409.
   */
  reactivate(id: string): Promise<MemberData> {
    const identity = requireIdentity();
    const ability = assertCanOrg(identity, "update");
    return this.guardSelf(identity, () =>
      this.runner.run(async (tx) => {
        const row = await this.targetOrg(
          tx,
          identity,
          ability,
          id,
          "self_suspend",
        );
        if (row.suspendedAt === null) throw new ApiError("request.conflict");
        const done = await this.repository.reactivateOrg(
          tx,
          identity.orgId,
          id,
        );
        if (done === undefined) throw new ApiError("request.conflict");
        const member = await this.reread(tx, identity, ability, id);
        await this.enqueueMfaCheck(tx, row.userId);
        await this.audit.record(tx, {
          action: `${ORG_SUBJECT}.reactivate`,
          entityType: ORG_SUBJECT,
          entityId: id,
          before: {
            userId: row.userId,
            roleId: row.roleId,
            suspendedAt: row.suspendedAt,
          },
          after: { suspendedAt: null },
        });
        return member;
      }),
    );
  }

  /**
   * A new end on a TEMPORARY org membership (org.member.update.org; owner
   * answer Q3): never oneself, with every key of the target, a reason
   * (audited), the end 1 hour to 366 days ahead. An expired one is
   * renewed the same way; a permanent one is 409.
   */
  renew(id: string, input: RenewInput): Promise<MemberData> {
    const identity = requireIdentity();
    const ability = assertCanOrg(identity, "update");
    return this.guardSelf(identity, () =>
      this.runner.run(async (tx) => {
        const row = await this.targetOrg(
          tx,
          identity,
          ability,
          id,
          "self_renew",
        );
        if (row.expiresAt === null) throw new ApiError("request.conflict");
        this.assertEnd(input.expiresAt);
        const done = await this.repository.renewOrg(
          tx,
          identity.orgId,
          id,
          input.expiresAt,
        );
        if (done === undefined) throw new ApiError("request.conflict");
        await this.scheduleExpiry(tx, {
          kind: "org",
          orgId: identity.orgId,
          id,
          userId: row.userId,
          expiresAt: input.expiresAt,
        });
        const member = await this.reread(tx, identity, ability, id);
        await this.enqueueMfaCheck(tx, row.userId);
        await this.audit.record(tx, {
          action: `${ORG_SUBJECT}.renew`,
          entityType: ORG_SUBJECT,
          entityId: id,
          before: {
            userId: row.userId,
            expiresAt: row.expiresAt,
            expiredAt: row.expiredAt,
          },
          after: {
            expiresAt: input.expiresAt,
            expiredAt: null,
            reason: input.reason,
          },
        });
        return member;
      }),
    );
  }

  /** The project's open membership `id`, checked: 404, self, holdsAll on the project. */
  private async targetProject(
    tx: Tx,
    identity: Identity,
    ability: Ability,
    projectId: string,
    id: string,
    self: DeniedReason,
  ): Promise<ProjectMembershipRow> {
    await this.repository.lockOrg(tx, identity.orgId);
    const row = await this.repository.findProject(
      tx,
      identity.orgId,
      projectId,
      id,
    );
    if (row === undefined) throw new ApiError("not_found");
    if (row.userId === identity.userId) {
      throw new SelfChange(id, PROJECT_SUBJECT, self);
    }
    this.refuse(
      identity,
      ability,
      effectiveKeys(
        await this.bundleOf(tx, identity.orgId, row.roleId, row.systemKey),
        normalOverrides(row.overrides),
      ),
      projectId,
    );
    return row;
  }

  private async rereadProject(
    tx: Tx,
    identity: Identity,
    ability: Ability,
    projectId: string,
    id: string,
  ): Promise<ProjectMemberData> {
    const row = await this.repository.findProject(
      tx,
      identity.orgId,
      projectId,
      id,
    );
    if (row === undefined) throw new ApiError("not_found");
    return this.presentProjectMember(
      tx,
      identity.orgId,
      row,
      this.viewOf(identity, ability),
    );
  }

  /**
   * Suspends a project membership (project.member.assign): as a project
   * removal does today (owner condition C2), the member's sessions stand
   * and their open access grants on that project end; the row and its
   * site assignment stay for the reactivation.
   */
  suspendProject(
    projectId: string,
    id: string,
    input: SuspendInput,
  ): Promise<ProjectMemberData> {
    const identity = requireIdentity();
    const ability = assertCanProject(identity, "assign", projectId);
    return this.guardSelf(identity, () =>
      this.runner.run(async (tx) => {
        const row = await this.targetProject(
          tx,
          identity,
          ability,
          projectId,
          id,
          "self_suspend",
        );
        if (row.suspendedAt !== null) throw new ApiError("request.conflict");
        const now = this.now();
        const suspended = await this.repository.suspendProject(
          tx,
          identity.orgId,
          id,
          { by: identity.userId, reason: input.reason, now },
        );
        if (suspended === undefined) throw new ApiError("request.conflict");
        const grantsEnded = await this.endGrants(
          tx,
          identity.orgId,
          row.userId,
          identity.userId,
          now,
          projectId,
        );
        const member = await this.rereadProject(
          tx,
          identity,
          ability,
          projectId,
          id,
        );
        await this.enqueueMfaCheck(tx, row.userId);
        await this.recordEndedGrants(
          tx,
          grantsEnded,
          `${PROJECT_SUBJECT}.suspend`,
        );
        await this.audit.record(tx, {
          action: `${PROJECT_SUBJECT}.suspend`,
          entityType: PROJECT_SUBJECT,
          entityId: id,
          before: {
            userId: row.userId,
            projectId: row.projectId,
            roleId: row.roleId,
            suspendedAt: null,
          },
          after: {
            suspendedAt: now,
            suspendedBy: identity.userId,
            reason: input.reason,
            accessGrantsRevoked: grantsEnded.length,
          },
        });
        return member;
      }),
    );
  }

  /** Ends a project membership's suspension (project.member.assign). */
  reactivateProject(projectId: string, id: string): Promise<ProjectMemberData> {
    const identity = requireIdentity();
    const ability = assertCanProject(identity, "assign", projectId);
    return this.guardSelf(identity, () =>
      this.runner.run(async (tx) => {
        const row = await this.targetProject(
          tx,
          identity,
          ability,
          projectId,
          id,
          "self_suspend",
        );
        if (row.suspendedAt === null) throw new ApiError("request.conflict");
        const done = await this.repository.reactivateProject(
          tx,
          identity.orgId,
          id,
        );
        if (done === undefined) throw new ApiError("request.conflict");
        const member = await this.rereadProject(
          tx,
          identity,
          ability,
          projectId,
          id,
        );
        await this.enqueueMfaCheck(tx, row.userId);
        await this.audit.record(tx, {
          action: `${PROJECT_SUBJECT}.reactivate`,
          entityType: PROJECT_SUBJECT,
          entityId: id,
          before: {
            userId: row.userId,
            projectId: row.projectId,
            suspendedAt: row.suspendedAt,
          },
          after: { suspendedAt: null },
        });
        return member;
      }),
    );
  }

  /**
   * A new end on a TEMPORARY project membership (project.member.assign):
   * as renew(); an archived project is 409.
   */
  renewProject(
    projectId: string,
    id: string,
    input: RenewInput,
  ): Promise<ProjectMemberData> {
    const identity = requireIdentity();
    const ability = assertCanProject(identity, "assign", projectId);
    return this.guardSelf(identity, () =>
      this.runner.run(async (tx) => {
        await this.assertOpenProject(tx, identity.orgId, projectId);
        const row = await this.targetProject(
          tx,
          identity,
          ability,
          projectId,
          id,
          "self_renew",
        );
        if (row.expiresAt === null) throw new ApiError("request.conflict");
        this.assertEnd(input.expiresAt);
        const done = await this.repository.renewProject(
          tx,
          identity.orgId,
          id,
          input.expiresAt,
        );
        if (done === undefined) throw new ApiError("request.conflict");
        await this.scheduleExpiry(tx, {
          kind: "project",
          orgId: identity.orgId,
          id,
          userId: row.userId,
          expiresAt: input.expiresAt,
        });
        const member = await this.rereadProject(
          tx,
          identity,
          ability,
          projectId,
          id,
        );
        await this.enqueueMfaCheck(tx, row.userId);
        await this.audit.record(tx, {
          action: `${PROJECT_SUBJECT}.renew`,
          entityType: PROJECT_SUBJECT,
          entityId: id,
          before: {
            userId: row.userId,
            projectId: row.projectId,
            expiresAt: row.expiresAt,
            expiredAt: row.expiredAt,
          },
          after: {
            expiresAt: input.expiresAt,
            expiredAt: null,
            reason: input.reason,
          },
        });
        return member;
      }),
    );
  }

  /** The caller's open org memberships in every org, with their project ids (no grant). */
  async listMine(): Promise<MyMembershipData[]> {
    const identity = requireIdentity();
    const nowMs = this.clock.now();
    return this.runner.run(async (tx) => {
      const rows = await this.repository.listMine(tx, identity.userId);
      return rows.memberships.map((row) => ({
        id: row.id,
        orgId: row.orgId,
        roleId: row.roleId,
        createdAt: row.createdAt,
        // A3: the status, never the suspension reason.
        status: statusOf(row, nowMs),
        expiresAt: row.expiresAt,
        external: row.external,
        projectIds: sorted(
          rows.projects
            .filter((project) => project.orgId === row.orgId)
            .map((project) => project.projectId),
        ),
      }));
    });
  }
}
