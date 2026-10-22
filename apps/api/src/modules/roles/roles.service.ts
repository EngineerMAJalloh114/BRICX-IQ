// Roles' service (P5-05, ADR 0066; plan 3.1, 3.2, 3.5): org-editable
// bundles. Each call: the identity, the policy check (403) before any
// database work, then one TxRunner transaction. The owner role is virtual
// (system_key owner, bundle ROLES.owner from code): 409 for any change.
// A change grants only keys the editor holds at org scope (holdsAll; 403
// with one grants.escalation line naming the first refused key). An edit
// writes revoke rows for dropped keys and new rows for added ones (the
// history stays), and, when the finance.* keys moved (D5), one
// users.mfa_check outbox row per member of the role; an archive is
// refused while a membership uses the role (409). Every change ends with
// one audit event (before and after: key, name, sorted keys), the last
// statement of the transaction (ADR 0055).
import type { Tx } from "@bricx/db/database";
import {
  type UuidV7Generator,
  createUuidV7Generator,
} from "@bricx/ids/uuid-v7";
import { MFA_KEY_PREFIX } from "@bricx/permissions/mfa";
import { ROLES } from "@bricx/permissions/roles";
import { Inject, Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { holdsAll } from "../../common/auth/holds.js";
import { CLOCK, type Clock } from "../../common/clock.js";
import type { Identity } from "../../common/db/request-context.js";
import { TxRunner } from "../../common/db/tx-runner.js";
import { ApiError } from "../../common/errors/api-error.js";
import { AuditService } from "../audit/public-api.js";
import { OutboxService } from "../outbox/public-api.js";
import {
  type AuditRecorder,
  type TransactionRunner,
  requireIdentity,
} from "../sessions/public-api.js";
import type { RoleData } from "./roles.dto.js";
import { USERS_MFA_CHECK, type UsersMfaCheck } from "./roles.events.js";
import { SUBJECT, assertCanManage, assertCanRead } from "./roles.policies.js";
import { type RoleRow, RolesRepository } from "./roles.repository.js";

/**
 * Most members one finance-moving edit fans users.mfa_check out to; above
 * it the edit is 409 (a reconcile job is a P14 Also line). (for architect
 * review)
 */
export const MAX_MFA_FANOUT = 1_000;

export interface CreateRoleInput {
  readonly key: string;
  readonly name: string;
  readonly permissions: readonly string[];
}

export interface UpdateRoleInput {
  readonly name?: string | undefined;
  readonly permissions?: readonly string[] | undefined;
}

export type OutboxWriter = Pick<OutboxService, "enqueue">;

/** What the controller calls. */
export type RolesPort = Pick<
  RolesService,
  "list" | "get" | "create" | "update" | "archive"
>;

const financeKeys = (keys: readonly string[]): Set<string> =>
  new Set(keys.filter((key) => key.startsWith(MFA_KEY_PREFIX)));

/** Whether the finance.* keys of a bundle differ (D5: the members' MFA need may move). */
export function financeChanged(
  before: readonly string[],
  after: readonly string[],
): boolean {
  const was = financeKeys(before);
  const is = financeKeys(after);
  if (was.size !== is.size) return true;
  for (const key of was) if (!is.has(key)) return true;
  return false;
}

const sorted = (keys: Iterable<string>): string[] => [...keys].sort();

/** The audit snapshot of a role. */
const snapshot = (row: RoleRow, permissions: readonly string[]) => ({
  key: row.key,
  name: row.name,
  permissions: sorted(permissions),
});

@Injectable()
export class RolesService {
  private readonly ids: UuidV7Generator;

  constructor(
    @Inject(TxRunner) private readonly runner: TransactionRunner,
    @Inject(RolesRepository) private readonly repository: RolesRepository,
    @Inject(AuditService) private readonly audit: AuditRecorder,
    @Inject(OutboxService) private readonly outbox: OutboxWriter,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    this.ids = createUuidV7Generator({ clock });
    this.logger.setContext("roles");
  }

  private now(): string {
    return new Date(this.clock.now()).toISOString();
  }

  /** The bundle of a row: the owner's from code, else its open rows. */
  private static bundleOf(
    row: RoleRow,
    bundles: ReadonlyMap<string, readonly string[]>,
  ): string[] {
    return sorted(
      row.systemKey === "owner" ? ROLES.owner : (bundles.get(row.id) ?? []),
    );
  }

  private static present(
    row: RoleRow,
    permissions: readonly string[],
  ): RoleData {
    return { ...row, permissions: sorted(permissions) };
  }

  /** The first key of `keys` the editor does not hold: 403, logged. */
  private refuseEscalation(
    identity: Identity,
    ability: ReturnType<typeof assertCanManage>,
    keys: readonly string[],
  ): void {
    const refused = holdsAll(ability, identity.orgId, keys);
    if (refused === undefined) return;
    this.logger.warn(
      { userId: identity.userId, orgId: identity.orgId, key: refused },
      "grants.escalation",
    );
    throw new ApiError("forbidden");
  }

  /** The org's open roles with their bundles (org.role.read.org). */
  async list(): Promise<RoleData[]> {
    const identity = requireIdentity();
    assertCanRead(identity);
    return this.runner.run(async (tx) => {
      const rows = await this.repository.list(tx, identity.orgId);
      const bundles = await this.repository.bundles(
        tx,
        identity.orgId,
        rows.map((row) => row.id),
      );
      return rows.map((row) =>
        RolesService.present(row, RolesService.bundleOf(row, bundles)),
      );
    });
  }

  /** One open role (404 otherwise). */
  async get(id: string): Promise<RoleData> {
    const identity = requireIdentity();
    assertCanRead(identity);
    return this.runner.run(async (tx) => {
      const { row, permissions } = await this.open(tx, identity, id);
      return RolesService.present(row, permissions);
    });
  }

  private async open(
    tx: Tx,
    identity: Identity,
    id: string,
  ): Promise<{ row: RoleRow; permissions: string[] }> {
    const row = await this.repository.findOpen(tx, identity.orgId, id);
    if (row === undefined) throw new ApiError("not_found");
    const bundles = await this.repository.bundles(tx, identity.orgId, [id]);
    return { row, permissions: RolesService.bundleOf(row, bundles) };
  }

  /** A custom role with `permissions` (org.role.manage.org, held keys only). */
  create(input: CreateRoleInput): Promise<RoleData> {
    const identity = requireIdentity();
    const ability = assertCanManage(identity);
    this.refuseEscalation(identity, ability, input.permissions);
    return this.runner.run(async (tx) => {
      const now = this.now();
      const row = await this.repository.insert(tx, {
        id: this.ids.next(),
        orgId: identity.orgId,
        key: input.key,
        name: input.name,
        now,
      });
      const permissions = sorted(new Set(input.permissions));
      await this.repository.grant(
        tx,
        identity.orgId,
        row.id,
        permissions.map((permission) => ({ id: this.ids.next(), permission })),
        now,
      );
      await this.audit.record(tx, {
        action: `${SUBJECT}.create`,
        entityType: SUBJECT,
        entityId: row.id,
        after: snapshot(row, permissions),
      });
      return RolesService.present(row, permissions);
    });
  }

  /** A new name and/or bundle; the owner role is 409. */
  update(id: string, input: UpdateRoleInput): Promise<RoleData> {
    const identity = requireIdentity();
    const ability = assertCanManage(identity);
    return this.runner.run(async (tx) => {
      const { row, permissions: before } = await this.open(tx, identity, id);
      if (row.systemKey === "owner") throw new ApiError("request.conflict");
      const after =
        input.permissions === undefined
          ? before
          : sorted(new Set(input.permissions));
      const was = new Set(before);
      const is = new Set(after);
      const added = after.filter((key) => !was.has(key));
      const removed = before.filter((key) => !is.has(key));
      this.refuseEscalation(identity, ability, added);
      const renamed = input.name !== undefined && input.name !== row.name;
      if (!renamed && added.length === 0 && removed.length === 0) {
        return RolesService.present(row, before);
      }
      const now = this.now();
      await this.repository.revoke(tx, identity.orgId, id, removed, now);
      await this.repository.grant(
        tx,
        identity.orgId,
        id,
        added.map((permission) => ({ id: this.ids.next(), permission })),
        now,
      );
      const updated = await this.repository.touch(tx, identity.orgId, id, {
        ...(renamed ? { name: input.name } : {}),
        now,
      });
      if (financeChanged(before, after)) {
        const members = await this.repository.memberUserIds(
          tx,
          identity.orgId,
          id,
          MAX_MFA_FANOUT + 1,
        );
        if (members.length > MAX_MFA_FANOUT) {
          throw new ApiError("request.conflict");
        }
        for (const userId of members) {
          const check: UsersMfaCheck = { userId };
          await this.outbox.enqueue(tx, USERS_MFA_CHECK, check);
        }
      }
      await this.audit.record(tx, {
        action: `${SUBJECT}.update`,
        entityType: SUBJECT,
        entityId: id,
        before: snapshot(row, before),
        after: snapshot(updated, after),
      });
      return RolesService.present(updated, after);
    });
  }

  /** Archives an unused custom or copied role; the owner role and a role in use are 409. */
  archive(id: string): Promise<RoleData> {
    const identity = requireIdentity();
    assertCanManage(identity);
    return this.runner.run(async (tx) => {
      const { row, permissions } = await this.open(tx, identity, id);
      if (row.systemKey === "owner") throw new ApiError("request.conflict");
      const holders = await this.repository.memberUserIds(
        tx,
        identity.orgId,
        id,
        1,
      );
      if (holders.length > 0) throw new ApiError("request.conflict");
      const archived = await this.repository.archive(
        tx,
        identity.orgId,
        id,
        this.now(),
      );
      if (archived === undefined) throw new ApiError("not_found");
      await this.audit.record(tx, {
        action: `${SUBJECT}.archive`,
        entityType: SUBJECT,
        entityId: id,
        before: snapshot(row, permissions),
      });
      return RolesService.present(archived, permissions);
    });
  }
}
