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
// - one users.mfa_check outbox row for the member (D5);
// - one audit event, the last statement (ADR 0055).
// The response carries mfaRequired: requiresMfa over the member's org
// bundle and every project membership's effective keys the transaction
// can read (condition 1).
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
import { errorEnvelope } from "@bricx/validation/error-envelope";
import { Inject, Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { holdsAll } from "../../common/auth/holds.js";
import { CLOCK, type Clock } from "../../common/clock.js";
import type { Identity } from "../../common/db/request-context.js";
import { TxRunner } from "../../common/db/tx-runner.js";
import { ApiError, ValidationError } from "../../common/errors/api-error.js";
import { AuditService } from "../audit/public-api.js";
import { OutboxService } from "../outbox/public-api.js";
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
import type {
  MemberData,
  MyMembershipData,
  OverridesInput,
  ProjectMemberData,
} from "./memberships.dto.js";
import {
  ORG_SUBJECT,
  PROJECT_SUBJECT,
  assertCanOrg,
  assertCanProject,
} from "./memberships.policies.js";
import {
  type MembershipRow,
  MembershipsRepository,
  type ProjectMembershipRow,
  type StoredOverrides,
} from "./memberships.repository.js";

export type OutboxWriter = Pick<OutboxService, "enqueue">;
export type SessionsRevoker = Pick<SessionsService, "revokeOfUserInTx">;

/** What the controllers call. */
export type MembershipsPort = Pick<
  MembershipsService,
  | "list"
  | "invite"
  | "update"
  | "remove"
  | "listProject"
  | "assign"
  | "updateProject"
  | "unassign"
  | "listMine"
>;

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

  private static member(row: MembershipRow, mfaRequired: boolean): MemberData {
    return {
      id: row.id,
      userId: row.userId,
      roleId: row.roleId,
      createdAt: row.createdAt,
      removedAt: row.removedAt,
      mfaRequired,
    };
  }

  private static projectMember(
    row: ProjectMembershipRow,
    mfaRequired: boolean,
  ): ProjectMemberData {
    return {
      id: row.id,
      projectId: row.projectId,
      userId: row.userId,
      roleId: row.roleId,
      overrides: normalOverrides(row.overrides),
      createdAt: row.createdAt,
      removedAt: row.removedAt,
      mfaRequired,
    };
  }

  private async presentMember(
    tx: Tx,
    orgId: string,
    row: MembershipRow,
  ): Promise<MemberData> {
    const mfa = await this.mfaOf(tx, orgId, [row.userId]);
    return MembershipsService.member(row, mfa.get(row.userId) === true);
  }

  private async presentProjectMember(
    tx: Tx,
    orgId: string,
    row: ProjectMembershipRow,
  ): Promise<ProjectMemberData> {
    const mfa = await this.mfaOf(tx, orgId, [row.userId]);
    return MembershipsService.projectMember(row, mfa.get(row.userId) === true);
  }

  private async enqueueMfaCheck(tx: Tx, userId: string): Promise<void> {
    const check: UsersMfaCheck = { userId };
    await this.outbox.enqueue(tx, USERS_MFA_CHECK, check);
  }

  /** 409 unless another open owner membership remains (under the org lock). */
  private async assertNotLastOwner(tx: Tx, orgId: string): Promise<void> {
    await this.repository.lockOrg(tx, orgId);
    if ((await this.repository.countOpenOwners(tx, orgId)) <= 1) {
      throw new ApiError("request.conflict");
    }
  }

  /** The org's open memberships (org.member.read.org). */
  async list(): Promise<MemberData[]> {
    const identity = requireIdentity();
    assertCanOrg(identity, "read");
    return this.runner.run(async (tx) => {
      const rows = await this.repository.listOrg(tx, identity.orgId);
      const mfa = await this.mfaOf(
        tx,
        identity.orgId,
        sorted(rows.map((row) => row.userId)),
      );
      return rows.map((row) =>
        MembershipsService.member(row, mfa.get(row.userId) === true),
      );
    });
  }

  /** A new org membership (org.member.invite.org; the role's keys held by the editor). */
  invite(input: {
    readonly userId: string;
    readonly roleId: string;
  }): Promise<MemberData> {
    const identity = requireIdentity();
    const ability = assertCanOrg(identity, "invite");
    return this.runner.run(async (tx) => {
      const role = await this.roleOf(tx, identity.orgId, input.roleId);
      this.refuse(identity, ability, role.keys);
      const row = await this.repository.insertOrg(
        tx,
        {
          id: this.ids.next(),
          orgId: identity.orgId,
          userId: input.userId,
          roleId: role.row.id,
          now: this.now(),
        },
        role.row.systemKey,
      );
      const member = await this.presentMember(tx, identity.orgId, row);
      await this.enqueueMfaCheck(tx, input.userId);
      await this.audit.record(tx, {
        action: `${ORG_SUBJECT}.invite`,
        entityType: ORG_SUBJECT,
        entityId: row.id,
        after: { userId: row.userId, roleId: row.roleId },
      });
      return member;
    });
  }

  /** A new role on an org membership (org.member.update.org). */
  update(id: string, input: { readonly roleId: string }): Promise<MemberData> {
    const identity = requireIdentity();
    const ability = assertCanOrg(identity, "update");
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
      if (input.roleId === row.roleId) {
        return this.presentMember(tx, identity.orgId, row);
      }
      const role = await this.roleOf(tx, identity.orgId, input.roleId);
      this.refuse(identity, ability, role.keys);
      if (row.systemKey === "owner" && role.row.systemKey !== "owner") {
        await this.assertNotLastOwner(tx, identity.orgId);
      }
      const updated = await this.repository.setOrgRole(
        tx,
        identity.orgId,
        id,
        role.row.id,
        role.row.systemKey,
      );
      const member = await this.presentMember(tx, identity.orgId, updated);
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
   * memberships in the org close, their sessions there are revoked
   * (cause admin), then the audit event.
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
      if (row.systemKey === "owner") {
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
      const sessions = await this.sessions.revokeOfUserInTx(
        tx,
        identity,
        row.userId,
      );
      await this.enqueueMfaCheck(tx, row.userId);
      await this.audit.record(tx, {
        action: `${ORG_SUBJECT}.remove`,
        entityType: ORG_SUBJECT,
        entityId: id,
        before: { userId: row.userId, roleId: row.roleId },
        after: {
          projectMembershipsClosed: projectsClosed,
          sessionsClosed: sessions.length,
        },
      });
    });
  }

  /** The project's open memberships (project.member.read at org or that project). */
  async listProject(projectId: string): Promise<ProjectMemberData[]> {
    const identity = requireIdentity();
    assertCanProject(identity, "read", projectId);
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
        MembershipsService.projectMember(row, mfa.get(row.userId) === true),
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

  /** A new project membership (project.member.assign; the user must be an org member). */
  assign(
    projectId: string,
    input: {
      readonly userId: string;
      readonly roleId: string;
      readonly overrides?: OverridesInput | undefined;
    },
  ): Promise<ProjectMemberData> {
    const identity = requireIdentity();
    const ability = assertCanProject(identity, "assign", projectId);
    return this.runner.run(async (tx) => {
      const role = await this.roleOf(tx, identity.orgId, input.roleId);
      const overrides = normalOverrides(input.overrides);
      const keys = this.effectiveOf(role, overrides);
      this.refuse(identity, ability, keys, projectId);
      const access = await this.repository.accessRowsOf(tx, identity.orgId, [
        input.userId,
      ]);
      if (access.memberships.length === 0) {
        throw new ApiError("request.conflict");
      }
      const row = await this.repository.insertProject(
        tx,
        {
          id: this.ids.next(),
          orgId: identity.orgId,
          projectId,
          userId: input.userId,
          roleId: role.row.id,
          overrides,
          now: this.now(),
        },
        role.row.systemKey,
      );
      const member = await this.presentProjectMember(tx, identity.orgId, row);
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
        },
      });
      return member;
    });
  }

  /** A new role and/or overrides on a project membership (project.member.assign). */
  updateProject(
    projectId: string,
    id: string,
    input: {
      readonly roleId?: string | undefined;
      readonly overrides?: OverridesInput | undefined;
    },
  ): Promise<ProjectMemberData> {
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
      if (role.row.id === row.roleId && sameOverrides(before, overrides)) {
        return this.presentProjectMember(tx, identity.orgId, row);
      }
      const updated = await this.repository.updateProject(
        tx,
        identity.orgId,
        id,
        { roleId: role.row.id, systemKey: role.row.systemKey, overrides },
      );
      const member = await this.presentProjectMember(
        tx,
        identity.orgId,
        updated,
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
        },
        after: {
          userId: row.userId,
          projectId: row.projectId,
          roleId: updated.roleId,
          overrides,
        },
      });
      return member;
    });
  }

  /** Removes a project membership (project.member.assign); sessions stand. */
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
      const removed = await this.repository.removeProject(
        tx,
        identity.orgId,
        id,
        this.now(),
      );
      if (removed === undefined) throw new ApiError("not_found");
      await this.enqueueMfaCheck(tx, row.userId);
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
      });
    });
  }

  /** The caller's open org memberships in every org, with their project ids (no grant). */
  async listMine(): Promise<MyMembershipData[]> {
    const identity = requireIdentity();
    return this.runner.run(async (tx) => {
      const rows = await this.repository.listMine(tx, identity.userId);
      return rows.memberships.map((row) => ({
        id: row.id,
        orgId: row.orgId,
        roleId: row.roleId,
        createdAt: row.createdAt,
        projectIds: sorted(
          rows.projects
            .filter((project) => project.orgId === row.orgId)
            .map((project) => project.projectId),
        ),
      }));
    });
  }
}
