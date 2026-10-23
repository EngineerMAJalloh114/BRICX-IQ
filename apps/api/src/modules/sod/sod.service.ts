// Segregation of duties on the server (P5-07, ADR 0068; CLAUDE.md rule
// 10; owner decisions D-A, D-B, D-C, D2 = (a), condition 2). Finance and
// supply modules (P9) call it inside the action's own transaction:
// - perform(tx, action): takes the chain's advisory lock (the one the
//   generated trigger takes), reads the chain's history from
//   bricx.sod_actions, runs checkSod (SOD_RULES, @bricx/permissions) with
//   the request identity's user as the actor, and writes the history row.
//   The actor is always identity.userId: an elevation changes what the
//   user may do, never who acted (DW6). A conflict is 403
//   permission.sod_violation with one `sod.violation` line naming the
//   rule; the trigger refusing the insert (the database backstop) is the
//   same answer. There is no override for anyone, owners included, and no
//   waiting it out: the history never expires (D2 = (a));
// - approvalState(tx, record): derived at read time (D-B): "approved"
//   once the chain holds the record's approve action; otherwise
//   "awaiting_approval" when another open member of the org, not an actor
//   of a conflicting action on the chain, holds the approve permission at
//   the record's scope (memberships or an active elevation; MFA is not
//   needed to count, D-C), else "sod_no_approver". The holders are read
//   with the grants source's own SQL (accessRowsFor) and built with the
//   one ability builder (abilityForGrants).
import {
  SodError,
  lockSodChain,
  recordSodAction,
  sodHistory,
} from "@bricx/db/sod";
import type { Tx } from "@bricx/db/database";
import { isUserId } from "@bricx/ids/branded";
import {
  type Ability,
  type PermissionRecord,
  canPermission,
} from "@bricx/permissions/ability";
import {
  type Action,
  type SubjectType,
  isPermissionName,
  isSubjectType,
  scopesOf,
} from "@bricx/permissions/catalogue";
import { PermissionError } from "@bricx/permissions/errors";
import { LIMITS } from "@bricx/permissions/limits";
import {
  SOD_RULES,
  type SodHistoryEntry,
  checkSod,
} from "@bricx/permissions/sod";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { PinoLogger } from "nestjs-pino";
import { abilityForGrants } from "../../common/auth/ability.js";
import {
  MAX_ACCESS_ROW_USERS,
  accessRowsFor,
  buildAccess,
} from "../../common/auth/grants-source.js";
import { CLOCK, type Clock } from "../../common/clock.js";
import { currentRequestContext } from "../../common/db/request-context.js";
import type { Identity } from "../../common/db/request-context.js";
import { ApiError } from "../../common/errors/api-error.js";

/** One action on a chain, as a module performs it. */
export interface SodAction {
  /** The originating record (the payment, the PO...). */
  readonly chainId: string;
  readonly recordId: string;
  /** A catalogue subject, e.g. finance.payment. */
  readonly recordType: string;
  /** One of the subject's catalogue actions, e.g. request. */
  readonly action: string;
  /** The record's project, null for an org-level record. */
  readonly projectId: string | null;
}

/** The record whose approval state is asked. */
export interface SodRecord {
  readonly chainId: string;
  readonly recordType: string;
  readonly projectId: string | null;
}

export type ApprovalState =
  "approved" | "awaiting_approval" | "sod_no_approver";

/**
 * Most open members read as approver candidates, oldest first, in batches
 * of MAX_ACCESS_ROW_USERS; past it the state is sod_no_approver (fail
 * closed: the request waits). (for architect review)
 */
export const MAX_APPROVER_CANDIDATES = 1_000;

/** The action every approval state is about. */
const APPROVE = "approve";

const isActionOf = (subject: SubjectType, action: string): action is Action =>
  scopesOf(subject, action) !== undefined;

/** The permissions a rule pairs with `permission` (both directions). */
function counterparts(permission: string): Set<string> {
  const out = new Set<string>();
  for (const rule of SOD_RULES) {
    if (rule.first === permission) out.add(rule.second);
    if (rule.second === permission) out.add(rule.first);
  }
  return out;
}

/** canPermission, a record the catalogue refuses being a refusal. */
function allows(
  ability: Ability,
  permission: string,
  record: PermissionRecord,
): boolean {
  try {
    return canPermission(ability, permission, record);
  } catch (error) {
    if (error instanceof PermissionError) return false;
    throw error;
  }
}

@Injectable()
export class SodService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  private identity(): Identity {
    const identity = currentRequestContext()?.identity;
    if (identity === undefined) throw new ApiError("forbidden");
    return identity;
  }

  /** Checks and records `action` by the request's user, in `tx` (403 on a conflict). */
  async perform(tx: Tx, action: SodAction): Promise<void> {
    const identity = this.identity();
    const actorId = identity.userId;
    const { recordType } = action;
    if (
      !isSubjectType(recordType) ||
      !isActionOf(recordType, action.action) ||
      !isUserId(actorId)
    ) {
      throw new SodError("invalid_entry");
    }
    await lockSodChain(tx, action.chainId);
    const history: SodHistoryEntry[] = [];
    for (const entry of await sodHistory(tx, action.chainId)) {
      const type = entry.recordType;
      if (
        !isSubjectType(type) ||
        !isActionOf(type, entry.action) ||
        !isUserId(entry.actorId)
      ) {
        throw new SodError("invalid_result");
      }
      history.push({
        chainId: entry.chainId,
        recordId: entry.recordId,
        recordType: type,
        action: entry.action,
        actorId: entry.actorId,
      });
    }
    let result;
    try {
      result = checkSod({
        chainId: action.chainId,
        recordId: action.recordId,
        recordType,
        action: action.action,
        actorId,
        history,
      });
    } catch (error) {
      // A chain longer than LIMITS.sodHistory takes no more actions.
      if (error instanceof PermissionError) {
        throw new ApiError("request.conflict");
      }
      throw error;
    }
    if (!result.ok) {
      this.logger.warn({ rule: result.rule }, "sod.violation");
      throw new ApiError("permission.sod_violation");
    }
    try {
      await recordSodAction(tx, {
        chainId: action.chainId,
        recordId: action.recordId,
        recordType,
        action: action.action,
        actorId,
        projectId: action.projectId,
        at: new Date(this.clock.now()).toISOString(),
      });
    } catch (error) {
      if (error instanceof SodError && error.code === "sod_violation") {
        this.logger.warn({ rule: "trigger" }, "sod.violation");
        throw new ApiError("permission.sod_violation");
      }
      throw error;
    }
  }

  /** The record's approval state, derived now (D-B). */
  async approvalState(tx: Tx, record: SodRecord): Promise<ApprovalState> {
    const identity = this.identity();
    const permission = `${record.recordType}.${APPROVE}`;
    if (!isPermissionName(permission)) throw new SodError("invalid_entry");
    const history = await sodHistory(tx, record.chainId);
    if (history.length > LIMITS.sodHistory) {
      throw new ApiError("request.conflict");
    }
    const ofRecord = history.filter((h) => h.recordType === record.recordType);
    if (ofRecord.some((h) => h.action === APPROVE)) return "approved";
    const conflicting = counterparts(permission);
    const excluded = new Set(
      history
        .filter((h) => conflicting.has(`${h.recordType}.${h.action}`))
        .map((h) => h.actorId),
    );
    const at = new Date(this.clock.now()).toISOString();
    const candidates = await tx.execute<{ user_id: unknown }>(
      sql`SELECT m.user_id::text AS user_id
          FROM bricx.memberships m
          WHERE m.org_id = app.current_org() AND m.removed_at IS NULL
          ORDER BY m.created_at, m.id
          LIMIT ${MAX_APPROVER_CANDIDATES}`,
    );
    const ids = candidates.rows
      .map((r) => r.user_id)
      .filter((id): id is string => typeof id === "string")
      .filter((id) => !excluded.has(id));
    const scope = {
      orgId: identity.orgId,
      ...(record.projectId === null ? {} : { projectId: record.projectId }),
      // A payment row carries created_by; the approve permission has no
      // own scope, so the value never decides the answer.
      createdBy: identity.userId,
    };
    for (let i = 0; i < ids.length; i += MAX_ACCESS_ROW_USERS) {
      const batch = ids.slice(i, i + MAX_ACCESS_ROW_USERS);
      for (const [userId, rows] of await accessRowsFor(tx, batch, at)) {
        const ability = abilityForGrants(
          identity.orgId,
          userId,
          buildAccess(rows).grants,
        );
        if (allows(ability, permission, scope)) return "awaiting_approval";
      }
    }
    return "sod_no_approver";
  }
}
