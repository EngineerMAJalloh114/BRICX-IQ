// Access grants' service (P5-06, ADR 0067; plan sections 2-3; owner
// conditions 5 and 6): temporary elevations, one catalogue key at one
// scope for one user for a bounded window. Each call: the identity, the
// policy check (403) before any database work, the pure checks of the
// request (422 with the field's path), then one TxRunner transaction.
// grant(): the granter never elevates themselves (userId, the requester
// ≠ approver shape); a project-level key names a project and an
// org-level key none (scopeId), an org key on a project-level resource,
// a site or own key is refused (permission; D-B); startsAt defaults to
// now and is at most 30 days ahead; the window is MIN_SECONDS to
// ACCESS_GRANT_MAX_SECONDS (D-C); the granter holds the key at org scope
// (holdsAll(): 403 with one grants.escalation line naming it) through
// their memberships alone, never through an elevation, and the three
// org.access_grant.* keys are never elevatable (permission; PR #71
// review, amendment 3, ADR 0067). In the
// transaction: at most ACCESS_GRANTS_MAX_PER_USER open grants per user
// and org (409, counted under the org and user's advisory lock), the
// row (an unknown user is 404), an open org membership and, for a
// project scope, an open project membership there (409), then the
// access_grants.expire outbox row due at expires_at, the users.mfa_check
// row (D5) and the org.access_grant.grant audit event, the last
// statement (ADR 0055), with the reason in `after`. revoke() needs
// org.access_grant.revoke.org only, never the key (condition 5): a
// revoker undoes any grant; sessions stay (D-D). The reason reaches the
// row, the response and the audit event; nothing here logs it
// (condition 6). `active` is computed at the Clock: started, not ended,
// not revoked; the worker's expired_at is a record of the end, never
// the rule.
import type { Tx } from "@bricx/db/database";
import {
  type UuidV7Generator,
  createUuidV7Generator,
} from "@bricx/ids/uuid-v7";
import {
  parseCatalogueKey,
  resourceOf,
  splitPermission,
} from "@bricx/permissions/catalogue";
import { errorEnvelope } from "@bricx/validation/error-envelope";
import { Inject, Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { membershipAbilityFor } from "../../common/auth/ability.js";
import { holdsAll } from "../../common/auth/holds.js";
import { CLOCK, type Clock } from "../../common/clock.js";
import type { Identity } from "../../common/db/request-context.js";
import { TxRunner } from "../../common/db/tx-runner.js";
import { ApiError, ValidationError } from "../../common/errors/api-error.js";
import { AuditService } from "../audit/public-api.js";
import { MembershipsRepository } from "../memberships/public-api.js";
import { OutboxService } from "../outbox/public-api.js";
import { USERS_MFA_CHECK, type UsersMfaCheck } from "../roles/public-api.js";
import {
  type AuditRecorder,
  type TransactionRunner,
  requireIdentity,
} from "../sessions/public-api.js";
import {
  type AccessGrantData,
  type CreateAccessGrantInput,
  MAX_START_AHEAD_SECONDS,
  MIN_SECONDS,
} from "./access-grants.dto.js";
import {
  ACCESS_GRANTS_EXPIRE,
  type AccessGrantsExpire,
} from "./access-grants.events.js";
import { SUBJECT, assertCan } from "./access-grants.policies.js";
import {
  type AccessGrantRow,
  AccessGrantsRepository,
} from "./access-grants.repository.js";

/** Injection token: the per-user cap from config (`accessGrants.maxPerUser`). */
export const ACCESS_GRANTS_MAX_PER_USER = Symbol("ACCESS_GRANTS_MAX_PER_USER");
/** Injection token: the longest window from config (`accessGrants.maxSeconds`). */
export const ACCESS_GRANT_MAX_SECONDS = Symbol("ACCESS_GRANT_MAX_SECONDS");

export type OutboxWriter = Pick<OutboxService, "enqueue">;
export type MembershipsReader = Pick<MembershipsRepository, "accessRowsOf">;

/** What the controllers call. */
export type AccessGrantsPort = Pick<
  AccessGrantsService,
  "list" | "grant" | "get" | "revoke" | "listMine"
>;

/** 422 validation_failed with one invalid_value issue at `path`. */
function invalid(path: readonly string[]): never {
  throw new ValidationError({
    ...errorEnvelope("validation_failed"),
    issues: [
      {
        path: [...path],
        code: "invalid_value",
        key: "validation:invalid_value",
      },
    ],
  });
}

/** The ISO instant of `ms`, as the rows carry it (milliseconds, UTC). */
const isoOf = (ms: number): string => new Date(ms).toISOString();

/** The scope of a key for an elevation: "org", "project", or the refused field. */
export function scopeOf(
  permission: string,
  scopeId: string | undefined,
): { readonly scope: "org" | "project" } | { readonly refused: string } {
  const parsed = parseCatalogueKey(permission);
  const parts =
    parsed === undefined ? undefined : splitPermission(parsed.permission);
  const level =
    parts === undefined ? undefined : resourceOf(parts.subject)?.level;
  if (parsed === undefined || parts === undefined || level === undefined)
    return { refused: "permission" };
  // The elevation keys themselves never are (PR #71 review, amendment 3).
  if (parts.subject === SUBJECT) return { refused: "permission" };
  if (parsed.scope === "org") {
    if (level !== "org") return { refused: "permission" };
    if (scopeId !== undefined) return { refused: "scopeId" };
    return { scope: "org" };
  }
  if (parsed.scope === "project") {
    if (level !== "project" && level !== "site")
      return { refused: "permission" };
    if (scopeId === undefined) return { refused: "scopeId" };
    return { scope: "project" };
  }
  return { refused: "permission" };
}

@Injectable()
export class AccessGrantsService {
  private readonly ids: UuidV7Generator;

  constructor(
    @Inject(TxRunner) private readonly runner: TransactionRunner,
    @Inject(AccessGrantsRepository)
    private readonly repository: AccessGrantsRepository,
    @Inject(MembershipsRepository)
    private readonly memberships: MembershipsReader,
    @Inject(AuditService) private readonly audit: AuditRecorder,
    @Inject(OutboxService) private readonly outbox: OutboxWriter,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
    @Inject(ACCESS_GRANTS_MAX_PER_USER) private readonly maxPerUser: number,
    @Inject(ACCESS_GRANT_MAX_SECONDS) private readonly maxSeconds: number,
  ) {
    this.ids = createUuidV7Generator({ clock });
    this.logger.setContext("access-grants");
  }

  /** A row as answered, with `active` judged at `nowMs`. */
  static present(row: AccessGrantRow, nowMs: number): AccessGrantData {
    return {
      id: row.id,
      orgId: row.orgId,
      userId: row.userId,
      permission: row.permission,
      scopeId: row.scopeId,
      reason: row.reason,
      grantedBy: row.grantedBy,
      startsAt: row.startsAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      revokedBy: row.revokedBy,
      expiredAt: row.expiredAt,
      active:
        row.revokedAt === null &&
        Date.parse(row.startsAt) <= nowMs &&
        nowMs < Date.parse(row.expiresAt),
      createdAt: row.createdAt,
    };
  }

  private async enqueueMfaCheck(tx: Tx, userId: string): Promise<void> {
    const check: UsersMfaCheck = { userId };
    await this.outbox.enqueue(tx, USERS_MFA_CHECK, check);
  }

  /** The org's open grants (org.access_grant.read.org), one user's when asked. */
  list(query: {
    readonly userId?: string | undefined;
  }): Promise<AccessGrantData[]> {
    const identity = requireIdentity();
    assertCan(identity, "read");
    const nowMs = this.clock.now();
    return this.runner.run(async (tx) => {
      const rows = await this.repository.list(
        tx,
        identity.orgId,
        isoOf(nowMs),
        query.userId,
      );
      return rows.map((row) => AccessGrantsService.present(row, nowMs));
    });
  }

  /** One grant of the org, whatever its state (org.access_grant.read.org). */
  get(id: string): Promise<AccessGrantData> {
    const identity = requireIdentity();
    assertCan(identity, "read");
    const nowMs = this.clock.now();
    return this.runner.run(async (tx) => {
      const row = await this.repository.find(tx, identity.orgId, id);
      if (row === undefined) throw new ApiError("not_found");
      return AccessGrantsService.present(row, nowMs);
    });
  }

  /** A new elevation (org.access_grant.grant.org; the key held by the granter). */
  grant(input: CreateAccessGrantInput): Promise<AccessGrantData> {
    const identity = requireIdentity();
    assertCan(identity, "grant");
    if (input.userId === identity.userId) invalid(["userId"]);
    const scope = scopeOf(input.permission, input.scopeId);
    if ("refused" in scope) invalid([scope.refused]);
    const nowMs = this.clock.now();
    const startsMs =
      input.startsAt === undefined ? nowMs : Date.parse(input.startsAt);
    const expiresMs = Date.parse(input.expiresAt);
    if (startsMs > nowMs + MAX_START_AHEAD_SECONDS * 1000)
      invalid(["startsAt"]);
    const seconds = (expiresMs - startsMs) / 1000;
    if (seconds < MIN_SECONDS || seconds > this.maxSeconds)
      invalid(["expiresAt"]);
    this.refuse(identity, input.permission);
    const scopeId = scope.scope === "project" ? (input.scopeId ?? null) : null;
    return this.runner.run(async (tx) => {
      const at = isoOf(nowMs);
      const open = await this.repository.countOpen(
        tx,
        identity.orgId,
        input.userId,
        at,
      );
      if (open >= this.maxPerUser) throw new ApiError("request.conflict");
      const row = await this.repository.insert(tx, {
        id: this.ids.next(),
        orgId: identity.orgId,
        userId: input.userId,
        permission: input.permission,
        scopeId,
        reason: input.reason,
        grantedBy: identity.userId,
        startsAt: isoOf(startsMs),
        expiresAt: isoOf(expiresMs),
        now: at,
      });
      await this.assertMember(tx, identity.orgId, input.userId, scopeId);
      const expire: AccessGrantsExpire = {
        grantId: row.id,
        userId: row.userId,
      };
      await this.outbox.enqueue(tx, ACCESS_GRANTS_EXPIRE, expire, {
        notBefore: row.expiresAt,
      });
      await this.enqueueMfaCheck(tx, row.userId);
      await this.audit.record(tx, {
        action: `${SUBJECT}.grant`,
        entityType: SUBJECT,
        entityId: row.id,
        after: {
          userId: row.userId,
          permission: row.permission,
          scopeId: row.scopeId,
          startsAt: row.startsAt,
          expiresAt: row.expiresAt,
          reason: row.reason,
        },
      });
      return AccessGrantsService.present(row, nowMs);
    });
  }

  /** Ends an open grant now (org.access_grant.revoke.org only; condition 5). */
  revoke(id: string): Promise<void> {
    const identity = requireIdentity();
    assertCan(identity, "revoke");
    const nowMs = this.clock.now();
    return this.runner.run(async (tx) => {
      const found = await this.repository.find(tx, identity.orgId, id);
      if (found === undefined) throw new ApiError("not_found");
      if (found.revokedAt !== null || found.expiredAt !== null) {
        throw new ApiError("request.conflict");
      }
      const row = await this.repository.revoke(
        tx,
        identity.orgId,
        id,
        identity.userId,
        isoOf(nowMs),
      );
      if (row === undefined) throw new ApiError("request.conflict");
      await this.enqueueMfaCheck(tx, row.userId);
      await this.audit.record(tx, {
        action: `${SUBJECT}.revoke`,
        entityType: SUBJECT,
        entityId: row.id,
        before: { revokedAt: null, revokedBy: null },
        after: { revokedAt: row.revokedAt, revokedBy: row.revokedBy },
      });
    });
  }

  /** The caller's active grants in the org (the own-row policy; no grant needed). */
  listMine(): Promise<AccessGrantData[]> {
    const identity = requireIdentity();
    const nowMs = this.clock.now();
    return this.runner.run(async (tx) => {
      const rows = await this.repository.listMine(
        tx,
        identity.orgId,
        identity.userId,
        isoOf(nowMs),
      );
      return rows.map((row) => AccessGrantsService.present(row, nowMs));
    });
  }

  /** 403, logged, unless the granter holds `key` at org scope (the escalation rule). */
  /**
   * 403 with one grants.escalation line unless the granter holds `key` at
   * org scope through their memberships alone: an elevation never counts
   * (PR #71 review, amendment 3, ADR 0067).
   */
  private refuse(identity: Identity, key: string): void {
    const refused = holdsAll(membershipAbilityFor(identity), identity.orgId, [
      key,
    ]);
    if (refused === undefined) return;
    this.logger.warn(
      { userId: identity.userId, orgId: identity.orgId, key: refused },
      "grants.escalation",
    );
    throw new ApiError("forbidden");
  }

  /** 409 unless `userId` has an open org membership and, with a scope, an open membership of that project. */
  private async assertMember(
    tx: Tx,
    orgId: string,
    userId: string,
    scopeId: string | null,
  ): Promise<void> {
    const rows = await this.memberships.accessRowsOf(tx, orgId, [userId]);
    if (!rows.memberships.some((row) => row.userId === userId)) {
      throw new ApiError("request.conflict");
    }
    if (
      scopeId !== null &&
      !rows.projects.some(
        (row) => row.userId === userId && row.projectId === scopeId,
      )
    ) {
      throw new ApiError("request.conflict");
    }
  }
}
