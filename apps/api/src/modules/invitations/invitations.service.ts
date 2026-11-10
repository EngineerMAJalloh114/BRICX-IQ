// Invitations' service (P6-06, ADR 0077). Each call: the identity (or the
// signed-in user, or nothing on activate), the policy check (403) before
// any database work, then its transactions.
// - create (D13): org.member.invite at org scope; a project invitation
//   also project.member.assign on that project. The keys granted (the
//   org role's bundle; the project role's on the project) must all be
//   held by the inviter's MEMBERSHIP grants (holdsAll; an elevation never
//   lets someone grant: ADR 0067 amendment 3). A refusal is 403 and one
//   deduplicated org.invitation.denied event (D17, C8). One pending
//   invitation per (org, project, address): 409 invitation.pending_exists
//   with the existing one in Location (D12); a pending row already past
//   its expiry is expired first (lazy expiry, D10). Then, in the same
//   transaction: the row, one invitations.send outbox row ({invitationId,
//   sendSeq, invitedBy}: the worker mints the token, D4, S7), one
//   org.invitation.create event.
// - resend (D11): pending and unexpired, at most INVITATION_MAX_RESENDS
//   (409 invitation.resend_limit after); send_seq moves on (the old token
//   dies when the worker mints the new one, S8, S20), the expiry restarts.
// - revoke: pending and unexpired: revoked (manual); already revoked:
//   nothing (idempotent); accepted or expired: 409 request.conflict.
// - activate (D6, @Public): ALWAYS the same 202. A token of this cell
//   whose hash matches a pending, unexpired invitation with fewer than
//   three activations counts one and writes one invitations.activate
//   outbox row (the worker creates or prompts the Keycloak account).
//   Every other case is one invitation.refused log line with the reason
//   (and the invitation id when there is one), never the token.
// - accept (D7, @SignedIn): the verified e-mail from the cell Keycloak's
//   userinfo (C3: sub equal to the token's, email_verified exactly true,
//   the invite's normaliser), then one transaction in the invitation's
//   org (its project in app.project_ids, never the wildcard) that
//   re-checks the hash in constant time, the address, the org and the
//   project, and the inviter (still a member holding what the invitation
//   grants: else the invitation is revoked inviter_lacks_rights, S17),
//   then the conditional UPDATE (S1, S2, S11), the memberships (ON
//   CONFLICT: an existing member is already_member, their role is never
//   changed; a missing project row is added), users.mfa_check and
//   org.invitation.accept. Every refusal is the same 404
//   invitation.unavailable (D8, S14); a userinfo outage is 503.
// Audit events never carry the address, the token or its hash (D17).
import type { Tx } from "@bricx/db/database";
import {
  type SettledInvitation,
  hashInvitationSecret,
  invitationByTokenHash,
  parseInvitationToken,
  sameInvitationHash,
} from "@bricx/db/invitations";
import { readInvitationTtlHours } from "@bricx/db/region-configs";
import { INVITATION_TTL_HOURS } from "@bricx/domain/limits";
import {
  type UuidV7Generator,
  createUuidV7Generator,
} from "@bricx/ids/uuid-v7";
import { type Ability, can } from "@bricx/permissions/ability";
import type { CatalogueKey } from "@bricx/permissions/catalogue";
import { effectiveKeys, knownKeys } from "@bricx/permissions/overrides";
import { ROLES } from "@bricx/permissions/roles";
import { normaliseEmail } from "@bricx/validation/email";
import { Inject, Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import {
  abilityFor,
  abilityForGrants,
  membershipAbilityFor,
} from "../../common/auth/ability.js";
import { accessRowsFor, buildAccess } from "../../common/auth/grants-source.js";
import { holdsAll } from "../../common/auth/holds.js";
import {
  signedInSubject,
  signedInUser,
} from "../../common/auth/signed-in.decorator.js";
import { CLOCK, type Clock } from "../../common/clock.js";
import type { Identity } from "../../common/db/request-context.js";
import { TxRunner } from "../../common/db/tx-runner.js";
import { ApiError } from "../../common/errors/api-error.js";
import {
  AuditService,
  DenialRecorder,
  type DeniedReason,
} from "../audit/public-api.js";
import { MembershipsRepository } from "../memberships/public-api.js";
import { OutboxService } from "../outbox/public-api.js";
import { ProjectsReader } from "../projects/public-api.js";
import {
  RolesRepository,
  USERS_MFA_CHECK,
  type UsersMfaCheck,
} from "../roles/public-api.js";
import { requireIdentity } from "../sessions/public-api.js";
import type {
  AcceptedInvitationData,
  CreateInvitationInput,
  InvitationData,
  ListInvitationsInput,
} from "./invitations.dto.js";
import {
  INVITATION_LIST_LIMIT,
  decodeCursor,
  encodeCursor,
} from "./invitations.dto.js";
import {
  type InvitationRow,
  InvitationsRepository,
} from "./invitations.repository.js";
import {
  USERINFO_CLIENT,
  type UserinfoClient,
  UserinfoRefused,
} from "./userinfo.js";

export const INVITATION_SUBJECT = "org.invitation";
export const INVITATIONS_SEND = "invitations.send";
export const INVITATIONS_ACTIVATE = "invitations.activate";
/** This cell's id: a token for another cell is refused (D3). */
export const INVITATIONS_CELL_ID = Symbol("INVITATIONS_CELL_ID");
/** INVITATION_MAX_RESENDS (D11). */
export const INVITATIONS_MAX_RESENDS = Symbol("INVITATIONS_MAX_RESENDS");

const HOUR_MS = 3_600_000;

/** Why activate or accept refused; logged, never answered (D8). */
export type RefusalReason =
  | "malformed"
  | "other_cell"
  | "unknown"
  | "not_pending"
  | "hash_mismatch"
  | "activation_limit"
  | "sub_mismatch"
  | "unverified"
  | "email_mismatch"
  | "self_invite"
  | "inviter_lacks_rights"
  | "role_archived"
  | "project_archived"
  | "org_archived"
  | "raced";

/** What the controllers call. */
export type InvitationsPort = Pick<
  InvitationsService,
  "create" | "list" | "get" | "resend" | "revoke" | "activate" | "accept"
>;

/** An authorisation refused inside a transaction: audited after the rollback. */
class Denied extends Error {
  constructor(
    readonly reason: DeniedReason,
    readonly entityId: string,
  ) {
    super("denied");
  }
}

/** A refusal accept answers uniformly (D8), after its transaction settles. */
class Refused extends Error {
  constructor(readonly reason: RefusalReason) {
    super("refused");
  }
}

interface RoleKeys {
  readonly roleId: string;
  readonly systemKey: string | null;
  readonly keys: readonly CatalogueKey[];
}

@Injectable()
export class InvitationsService {
  private readonly ids: UuidV7Generator;

  constructor(
    @Inject(TxRunner) private readonly runner: TxRunner,
    @Inject(InvitationsRepository)
    private readonly repository: InvitationsRepository,
    @Inject(MembershipsRepository)
    private readonly memberships: MembershipsRepository,
    @Inject(RolesRepository) private readonly roles: RolesRepository,
    @Inject(ProjectsReader)
    private readonly projects: Pick<ProjectsReader, "stateOf">,
    @Inject(AuditService)
    private readonly audit: Pick<AuditService, "record" | "recordSystem">,
    @Inject(OutboxService)
    private readonly outbox: Pick<OutboxService, "enqueue">,
    @Inject(DenialRecorder)
    private readonly denials: Pick<DenialRecorder, "record">,
    @Inject(USERINFO_CLIENT) private readonly userinfo: UserinfoClient,
    @Inject(INVITATIONS_CELL_ID) private readonly cellId: string,
    @Inject(INVITATIONS_MAX_RESENDS) private readonly maxResends: number,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    this.ids = createUuidV7Generator({ clock });
    this.logger.setContext("invitations");
  }

  private now(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private static present(row: InvitationRow): InvitationData {
    return {
      id: row.id,
      orgId: row.orgId,
      projectId: row.projectId,
      email: row.email,
      roleId: row.roleId,
      projectRoleId: row.projectRoleId,
      status: row.status,
      expiresAt: row.expiresAt,
      resendCount: row.resendCount,
      lastSentAt: row.lastSentAt,
      invitedBy: row.invitedBy,
      acceptedBy: row.acceptedBy,
      acceptedAt: row.acceptedAt,
      revokedBy: row.revokedBy,
      revokedAt: row.revokedAt,
      revokeReason: row.revokeReason,
      createdAt: row.createdAt,
    };
  }

  /** What the audit events carry: never the address, a token or its hash. */
  private static audited(row: InvitationRow): Record<string, unknown> {
    return {
      status: row.status,
      projectId: row.projectId,
      roleId: row.roleId,
      projectRoleId: row.projectRoleId,
      expiresAt: row.expiresAt,
      resendCount: row.resendCount,
    };
  }

  /** The open role `roleId` and its keys (the owner's from code); undefined when archived or unknown. */
  private async roleKeys(
    tx: Tx,
    orgId: string,
    roleId: string,
  ): Promise<RoleKeys | undefined> {
    const row = await this.roles.findOpen(tx, orgId, roleId);
    if (row === undefined) return undefined;
    if (row.systemKey === "owner") {
      return { roleId: row.id, systemKey: row.systemKey, keys: ROLES.owner };
    }
    const bundles = await this.roles.bundles(tx, orgId, [row.id]);
    return {
      roleId: row.id,
      systemKey: row.systemKey,
      keys: knownKeys(bundles.get(row.id) ?? []).known,
    };
  }

  /** The keys a project role grants on its project (no overrides). */
  private static projectKeys(role: RoleKeys): readonly CatalogueKey[] {
    return effectiveKeys(role.keys, { add: [], remove: [] });
  }

  /** The first key `ability` does not hold for the invitation, or undefined. */
  private static refusedKey(
    ability: Ability,
    orgId: string,
    role: RoleKeys,
    project: { readonly id: string; readonly role: RoleKeys } | undefined,
  ): string | undefined {
    return (
      holdsAll(ability, orgId, role.keys) ??
      (project === undefined
        ? undefined
        : holdsAll(
            ability,
            orgId,
            InvitationsService.projectKeys(project.role),
            project.id,
          ))
    );
  }

  /** One org.invitation.expire event (system) per row a lazy expiry settled. */
  private async recordExpired(
    tx: Tx,
    settled: readonly SettledInvitation[],
  ): Promise<void> {
    for (const row of settled) {
      await this.audit.recordSystem(tx, {
        action: `${INVITATION_SUBJECT}.expire`,
        entityType: INVITATION_SUBJECT,
        entityId: row.id,
        before: { status: "pending" },
        after: { status: "expired", projectId: row.projectId },
      });
    }
  }

  /** 403 unless `identity` may invite at org scope (and assign on the project). */
  private static assertMayInvite(
    identity: Identity,
    projectId: string | undefined,
  ): void {
    const ability = abilityFor(identity);
    if (!can(ability, "invite", "org.member", { orgId: identity.orgId })) {
      throw new ApiError("forbidden");
    }
    if (
      projectId !== undefined &&
      !can(ability, "assign", "project.member", {
        orgId: identity.orgId,
        projectId,
      })
    ) {
      throw new ApiError("forbidden");
    }
  }

  private async denied(identity: Identity, error: Denied): Promise<never> {
    this.logger.warn(
      { userId: identity.userId, orgId: identity.orgId, reason: error.reason },
      "invitation.denied",
    );
    await this.denials.record({
      orgId: identity.orgId,
      actorId: identity.userId,
      reason: error.reason,
      entityId: error.entityId,
    });
    throw new ApiError("forbidden");
  }

  /** A new invitation (D13, D12, D4). */
  async create(input: CreateInvitationInput): Promise<InvitationData> {
    const identity = requireIdentity();
    InvitationsService.assertMayInvite(identity, input.projectId);
    const ability = membershipAbilityFor(identity);
    const id = this.ids.next();
    try {
      return await this.runner.run(async (tx) => {
        const now = this.now();
        const role = await this.roleKeys(tx, identity.orgId, input.roleId);
        if (role === undefined) throw new ApiError("not_found");
        let project: { id: string; role: RoleKeys } | undefined;
        if (input.projectId !== undefined) {
          const state = await this.projects.stateOf(
            tx,
            identity.orgId,
            input.projectId,
          );
          if (state === undefined) throw new ApiError("not_found");
          if (state.status === "archived") {
            throw new ApiError("request.conflict");
          }
          const projectRole = await this.roleKeys(
            tx,
            identity.orgId,
            input.projectRoleId ?? "",
          );
          if (projectRole === undefined) throw new ApiError("not_found");
          project = { id: input.projectId, role: projectRole };
        }
        const refused = InvitationsService.refusedKey(
          ability,
          identity.orgId,
          role,
          project,
        );
        if (refused !== undefined) throw new Denied("escalation", id);
        const projectId = input.projectId ?? null;
        await this.recordExpired(
          tx,
          await this.repository.expireStale(tx, {
            orgId: identity.orgId,
            projectId,
            email: input.email,
            now,
          }),
        );
        const hours =
          (await readInvitationTtlHours(tx, identity.orgId)) ??
          INVITATION_TTL_HOURS.default;
        const row = await this.repository.insert(tx, {
          id,
          orgId: identity.orgId,
          projectId,
          email: input.email,
          roleId: role.roleId,
          projectRoleId: project?.role.roleId ?? null,
          invitedBy: identity.userId,
          expiresAt: new Date(Date.parse(now) + hours * HOUR_MS).toISOString(),
          now,
        });
        if (row === undefined) {
          const existing = await this.repository.pendingId(tx, {
            orgId: identity.orgId,
            projectId,
            email: input.email,
          });
          throw new ApiError("invitation.pending_exists", {
            ...(existing === undefined
              ? {}
              : { location: `/v1/invitations/${existing}` }),
          });
        }
        await this.outbox.enqueue(tx, INVITATIONS_SEND, {
          invitationId: row.id,
          sendSeq: row.sendSeq,
          invitedBy: identity.userId,
        });
        await this.audit.record(tx, {
          action: `${INVITATION_SUBJECT}.create`,
          entityType: INVITATION_SUBJECT,
          entityId: row.id,
          after: InvitationsService.audited(row),
        });
        return InvitationsService.present(row);
      });
    } catch (error) {
      if (error instanceof Denied) return this.denied(identity, error);
      throw error;
    }
  }

  /** The org's invitations, newest first (org.member.read). */
  async list(
    query: ListInvitationsInput,
  ): Promise<{ items: InvitationData[]; nextCursor: string | null }> {
    const identity = requireIdentity();
    const limit = query.limit ?? INVITATION_LIST_LIMIT;
    const beforeId =
      query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    const rows = await this.runner.run((tx) =>
      this.repository.list(tx, identity.orgId, {
        status: query.status,
        projectId: query.projectId,
        beforeId,
        limit: limit + 1,
        now: this.now(),
      }),
    );
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map((row) => InvitationsService.present(row)),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor(last.id)
          : null,
    };
  }

  /** One invitation, whatever its status (org.member.read). */
  async get(id: string): Promise<InvitationData> {
    const identity = requireIdentity();
    const row = await this.runner.run((tx) =>
      this.repository.find(tx, identity.orgId, id, this.now()),
    );
    if (row === undefined) throw new ApiError("not_found");
    return InvitationsService.present(row);
  }

  /** A new send of a pending invitation (D11). */
  async resend(id: string): Promise<InvitationData> {
    const identity = requireIdentity();
    return this.runner.run(async (tx) => {
      const now = this.now();
      const row = await this.repository.find(tx, identity.orgId, id, now);
      if (row === undefined) throw new ApiError("not_found");
      if (row.status !== "pending") throw new ApiError("request.conflict");
      if (row.resendCount >= this.maxResends) {
        throw new ApiError("invitation.resend_limit");
      }
      const hours =
        (await readInvitationTtlHours(tx, identity.orgId)) ??
        INVITATION_TTL_HOURS.default;
      const updated = await this.repository.resend(tx, {
        orgId: identity.orgId,
        id,
        expiresAt: new Date(Date.parse(now) + hours * HOUR_MS).toISOString(),
        maxResends: this.maxResends,
        now,
      });
      if (updated === undefined) throw new ApiError("request.conflict");
      await this.outbox.enqueue(tx, INVITATIONS_SEND, {
        invitationId: updated.id,
        sendSeq: updated.sendSeq,
        invitedBy: updated.invitedBy,
      });
      await this.audit.record(tx, {
        action: `${INVITATION_SUBJECT}.resend`,
        entityType: INVITATION_SUBJECT,
        entityId: id,
        before: InvitationsService.audited(row),
        after: InvitationsService.audited(updated),
      });
      return InvitationsService.present(updated);
    });
  }

  /** Revokes a pending invitation (idempotent: a revoked one is left as is). */
  async revoke(id: string): Promise<void> {
    const identity = requireIdentity();
    await this.runner.run(async (tx) => {
      const now = this.now();
      const row = await this.repository.find(tx, identity.orgId, id, now);
      if (row === undefined) throw new ApiError("not_found");
      if (row.status === "revoked") return;
      if (row.status !== "pending") throw new ApiError("request.conflict");
      const revoked = await this.repository.revoke(tx, {
        orgId: identity.orgId,
        id,
        by: identity.userId,
        reason: "manual",
        now,
      });
      if (revoked === undefined) throw new ApiError("request.conflict");
      await this.audit.record(tx, {
        action: `${INVITATION_SUBJECT}.revoke`,
        entityType: INVITATION_SUBJECT,
        entityId: id,
        before: InvitationsService.audited(row),
        after: { ...InvitationsService.audited(revoked), reason: "manual" },
      });
    });
  }

  private refusal(reason: RefusalReason, invitationId?: string): void {
    this.logger.info(
      { reason, ...(invitationId === undefined ? {} : { invitationId }) },
      "invitation.refused",
    );
  }

  /** The invitation a token names, through the definer lookup (D1). */
  private async lookup(
    token: string,
    run: <T>(orgId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>,
  ): Promise<
    | {
        readonly ref: { id: string; orgId: string; invitedBy: string };
        readonly hash: Buffer;
      }
    | RefusalReason
  > {
    const parsed = parseInvitationToken(token);
    if (parsed === undefined) return "malformed";
    if (parsed.cellId !== this.cellId) return "other_cell";
    const hash = hashInvitationSecret(parsed.secret);
    // The lookup crosses orgs (SECURITY DEFINER); its transaction's org is
    // a fresh id that names nothing (the user-provisioning precedent).
    const ref = await run(this.ids.next(), (tx) =>
      invitationByTokenHash(tx, hash),
    );
    if (ref === undefined) return "unknown";
    return { ref, hash };
  }

  /** Activation (D6): always the same answer. */
  async activate(token: string): Promise<{ status: "accepted" }> {
    const accepted = { status: "accepted" as const };
    const found = await this.lookup(token, (orgId, fn) =>
      // No user yet: the lookup runs as a fresh id too.
      this.runner.runAs({ orgId, userId: this.ids.next() }, fn),
    );
    if (typeof found === "string") {
      this.refusal(found);
      return accepted;
    }
    const { ref, hash } = found;
    const outcome = await this.runner.runAs(
      { orgId: ref.orgId, userId: ref.invitedBy },
      async (tx): Promise<RefusalReason | undefined> => {
        const now = this.now();
        const row = await this.repository.findForAccept(
          tx,
          ref.orgId,
          ref.id,
          now,
        );
        if (row === undefined) return "unknown";
        if (
          row.tokenHash === null ||
          !sameInvitationHash(row.tokenHash, hash)
        ) {
          return "hash_mismatch";
        }
        if (row.status !== "pending") return "not_pending";
        if (await this.repository.orgArchived(tx)) return "org_archived";
        const counted = await this.repository.activate(tx, {
          orgId: ref.orgId,
          id: ref.id,
          hash,
          now,
        });
        if (!counted) return "activation_limit";
        await this.outbox.enqueue(tx, INVITATIONS_ACTIVATE, {
          invitationId: ref.id,
          invitedBy: ref.invitedBy,
        });
        return undefined;
      },
    );
    if (outcome === undefined) {
      this.logger.info({ invitationId: ref.id }, "invitation.activation");
    } else {
      this.refusal(outcome, ref.id);
    }
    return accepted;
  }

  /** The verified, normalised address of the signed-in caller (C3). */
  private async verifiedEmail(
    bearer: string,
  ): Promise<{ readonly email: string } | { readonly refused: RefusalReason }> {
    const subject = signedInSubject();
    if (subject === undefined) throw new ApiError("unauthenticated");
    let answer;
    try {
      answer = await this.userinfo.read(bearer);
    } catch (error) {
      if (error instanceof UserinfoRefused) {
        throw new ApiError("unauthenticated");
      }
      this.logger.warn({}, "invitation.userinfo_unavailable");
      throw new ApiError("server_unavailable");
    }
    if (answer.sub !== subject) return { refused: "sub_mismatch" };
    if (!answer.emailVerified) return { refused: "unverified" };
    const email = normaliseEmail(answer.email);
    if (email === undefined) return { refused: "unverified" };
    return { email: String(email) };
  }

  /** The inviter's membership grants still cover the invitation (S17). */
  private async inviterHolds(
    tx: Tx,
    row: InvitationRow,
    role: RoleKeys,
    project: { readonly id: string; readonly role: RoleKeys } | undefined,
  ): Promise<boolean> {
    const rows = (await accessRowsFor(tx, [row.invitedBy], this.now())).get(
      row.invitedBy,
    );
    if (rows === undefined) return false;
    const ability = abilityForGrants(
      row.orgId,
      row.invitedBy,
      buildAccess(rows).membershipGrants,
    );
    if (!can(ability, "invite", "org.member", { orgId: row.orgId })) {
      return false;
    }
    if (
      project !== undefined &&
      !can(ability, "assign", "project.member", {
        orgId: row.orgId,
        projectId: project.id,
      })
    ) {
      return false;
    }
    return (
      InvitationsService.refusedKey(ability, row.orgId, role, project) ===
      undefined
    );
  }

  /** Accept (D7): the uniform 404 for every refusal (D8). */
  async accept(token: string, bearer: string): Promise<AcceptedInvitationData> {
    const user = signedInUser();
    if (user === undefined) throw new ApiError("unauthenticated");
    const uniform = (reason: RefusalReason, id?: string): never => {
      this.refusal(reason, id);
      throw new ApiError("invitation.unavailable");
    };
    const found = await this.lookup(token, (orgId, fn) =>
      this.runner.runSignedIn(orgId, fn),
    );
    if (typeof found === "string") return uniform(found);
    const { ref, hash } = found;
    const verified = await this.verifiedEmail(bearer);
    if ("refused" in verified) return uniform(verified.refused, ref.id);
    const { email } = verified;
    if (ref.invitedBy === user.userId) {
      await this.denials.record({
        orgId: ref.orgId,
        actorId: user.userId,
        reason: "self_invite",
        entityId: ref.id,
      });
      return uniform("self_invite", ref.id);
    }
    // The project id first (immutable), so the accept transaction sees
    // that one project and no other.
    const projectId = await this.runner.runSignedIn(ref.orgId, async (tx) => {
      const row = await this.repository.find(tx, ref.orgId, ref.id, this.now());
      return row?.projectId ?? null;
    });
    let result: AcceptedInvitationData | "inviter_lacks_rights";
    try {
      result = await this.runner.runSignedIn(
        ref.orgId,
        (tx) => this.acceptIn(tx, { ref, hash, email, userId: user.userId }),
        projectId === null ? [] : [projectId],
      );
    } catch (error) {
      if (error instanceof Refused) return uniform(error.reason, ref.id);
      throw error;
    }
    if (result === "inviter_lacks_rights") {
      await this.denials.record({
        orgId: ref.orgId,
        actorId: user.userId,
        reason: "inviter_lacks_rights",
        entityId: ref.id,
      });
      return uniform("inviter_lacks_rights", ref.id);
    }
    this.logger.info(
      { invitationId: ref.id, orgId: ref.orgId, outcome: result.outcome },
      "invitation.accepted",
    );
    return result;
  }

  /**
   * The accept transaction. The one refusal that must leave a trace (the
   * inviter-lacks-rights revoke) commits it and answers
   * "inviter_lacks_rights"; every other refusal throws Refused (rolled
   * back).
   */
  private async acceptIn(
    tx: Tx,
    input: {
      readonly ref: { id: string; orgId: string; invitedBy: string };
      readonly hash: Buffer;
      readonly email: string;
      readonly userId: string;
    },
  ): Promise<AcceptedInvitationData | "inviter_lacks_rights"> {
    const { ref, hash, email, userId } = input;
    const now = this.now();
    const row = await this.repository.findForAccept(tx, ref.orgId, ref.id, now);
    if (row === undefined) throw new Refused("unknown");
    if (row.tokenHash === null || !sameInvitationHash(row.tokenHash, hash)) {
      throw new Refused("hash_mismatch");
    }
    if (row.status !== "pending") throw new Refused("not_pending");
    if (row.email !== email) throw new Refused("email_mismatch");
    if (await this.repository.orgArchived(tx))
      throw new Refused("org_archived");
    if (row.projectId !== null) {
      const state = await this.projects.stateOf(tx, ref.orgId, row.projectId);
      if (state === undefined || state.status === "archived") {
        throw new Refused("project_archived");
      }
    }
    const role = await this.roleKeys(tx, ref.orgId, row.roleId);
    const projectRole =
      row.projectRoleId === null
        ? undefined
        : await this.roleKeys(tx, ref.orgId, row.projectRoleId);
    if (role === undefined || (row.projectRoleId !== null && !projectRole)) {
      throw new Refused("role_archived");
    }
    const project =
      row.projectId === null || projectRole === undefined
        ? undefined
        : { id: row.projectId, role: projectRole };
    if (!(await this.inviterHolds(tx, row, role, project))) {
      const revoked = await this.repository.revoke(tx, {
        orgId: ref.orgId,
        id: ref.id,
        by: null,
        reason: "inviter_lacks_rights",
        now,
      });
      if (revoked !== undefined) {
        await this.audit.recordSystem(tx, {
          action: `${INVITATION_SUBJECT}.revoke`,
          entityType: INVITATION_SUBJECT,
          entityId: ref.id,
          before: InvitationsService.audited(row),
          after: {
            ...InvitationsService.audited(revoked),
            reason: "inviter_lacks_rights",
          },
        });
      }
      // Committed: the revoke stands; the caller answers uniformly.
      return "inviter_lacks_rights";
    }
    const moved = await this.repository.accept(tx, {
      orgId: ref.orgId,
      id: ref.id,
      hash,
      userId,
      now,
    });
    if (!moved) throw new Refused("raced");
    const joinedOrg = await this.memberships.insertOrgIfAbsent(
      tx,
      {
        id: this.ids.next(),
        orgId: ref.orgId,
        userId,
        roleId: role.roleId,
        now,
      },
      role.systemKey,
    );
    let joinedProject = false;
    if (project !== undefined) {
      const inserted = await this.memberships.insertProjectIfAbsent(
        tx,
        {
          id: this.ids.next(),
          orgId: ref.orgId,
          projectId: project.id,
          userId,
          roleId: project.role.roleId,
          overrides: { add: [], remove: [] },
          now,
        },
        project.role.systemKey,
      );
      joinedProject = inserted !== undefined;
    }
    const outcome =
      joinedOrg !== undefined || joinedProject ? "joined" : "already_member";
    const check: UsersMfaCheck = { userId };
    await this.outbox.enqueue(tx, USERS_MFA_CHECK, check);
    await this.audit.record(tx, {
      action: `${INVITATION_SUBJECT}.accept`,
      entityType: INVITATION_SUBJECT,
      entityId: ref.id,
      before: InvitationsService.audited(row),
      after: {
        ...InvitationsService.audited(row),
        status: "accepted",
        outcome,
        orgMembershipAdded: joinedOrg !== undefined,
        projectMembershipAdded: joinedProject,
      },
    });
    return { orgId: ref.orgId, projectId: row.projectId, outcome };
  }
}
