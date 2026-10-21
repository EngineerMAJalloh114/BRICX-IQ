// Sessions' service (P5-03, ADR 0063). Own sessions: list (every org the
// user is signed into: the own-row policy) and revoke one. Administrator:
// list and revoke a user's sessions in the request's org, behind
// org.session.read.org / org.session.revoke.org (production grants nobody
// until P5-05: deny-all). Every revoke, in one transaction: the rows
// closed, one sessions.revoked outbox row per closed session and one
// org.session.revoke audit event in the request's org chain listing every
// closed session with its org (owner condition 2); the audit event is the
// last statement (ADR 0055). A revoke that closes nothing writes nothing.
import { Inject, Injectable } from "@nestjs/common";
import type { Tx } from "@bricx/db/database";
import { CLOCK, type Clock } from "../../common/clock.js";
import {
  type Identity,
  NoTenantContextError,
  currentRequestContext,
} from "../../common/db/request-context.js";
import { TxRunner } from "../../common/db/tx-runner.js";
import { ApiError } from "../../common/errors/api-error.js";
import { AuditService } from "../audit/public-api.js";
import { OutboxService } from "../outbox/public-api.js";
import type { SessionData } from "./sessions.dto.js";
import { SESSIONS_REVOKED, type SessionRevoked } from "./sessions.events.js";
import {
  SUBJECT,
  assertCanReadOrg,
  assertCanRevokeOrg,
} from "./sessions.policies.js";
import {
  type ClosedSession,
  type SessionRow,
  SessionsRepository,
} from "./sessions.repository.js";

/** Why sessions were closed, in the audit event. */
export type RevokeCause = "self" | "device" | "admin";

// The dependencies are typed by what is used (unit tests hand in plain
// objects); the injection tokens stay the classes.
export type TransactionRunner = Pick<TxRunner, "run">;
export type AuditRecorder = Pick<AuditService, "record">;
export type OutboxWriter = Pick<OutboxService, "enqueue">;

export function requireIdentity(): Identity {
  const identity = currentRequestContext()?.identity;
  if (identity === undefined) throw new NoTenantContextError();
  return identity;
}

/** What the controllers call. */
export type SessionsPort = Pick<
  SessionsService,
  "listMine" | "revokeMine" | "listOfUser" | "revokeOfUser"
>;
/** What the devices module calls, inside its own transaction. */
export type SessionsOfDevicePort = Pick<
  SessionsService,
  "bindCurrentSession" | "revokeOnDevice"
>;

@Injectable()
export class SessionsService {
  constructor(
    @Inject(TxRunner) private readonly runner: TransactionRunner,
    @Inject(SessionsRepository)
    private readonly repository: SessionsRepository,
    @Inject(AuditService) private readonly audit: AuditRecorder,
    @Inject(OutboxService) private readonly outbox: OutboxWriter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private now(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private present(
    identity: Identity,
    rows: readonly SessionRow[],
  ): SessionData[] {
    return rows.map((row) => ({
      ...row,
      current: row.id === identity.sessionId,
    }));
  }

  /** The caller's sessions in every org. */
  async listMine(): Promise<SessionData[]> {
    const identity = requireIdentity();
    const rows = await this.runner.run((tx) =>
      this.repository.listOfUser(tx, identity.userId),
    );
    return this.present(identity, rows);
  }

  /** Closes the caller's session `id`; 404 when it is not theirs. */
  async revokeMine(id: string): Promise<void> {
    const identity = requireIdentity();
    await this.runner.run(async (tx) => {
      const closed = await this.repository.closeOne(
        tx,
        identity.userId,
        id,
        this.now(),
      );
      if (closed.length === 0) {
        // Already closed is fine (idempotent); unknown or another user's is 404.
        if (await this.repository.exists(tx, identity.userId, id)) return;
        throw new ApiError("not_found");
      }
      await this.recordRevoke(tx, identity, "self", closed, { sessionId: id });
    });
  }

  /**
   * Closes the caller's open sessions on `deviceId` inside the caller's
   * transaction (the devices module's revoke): the outbox rows and the
   * audit event go with them. Returns what was closed.
   */
  async revokeOnDevice(
    tx: Tx,
    identity: Identity,
    deviceId: string,
  ): Promise<ClosedSession[]> {
    const closed = await this.repository.closeOnDevice(
      tx,
      identity.userId,
      deviceId,
      this.now(),
    );
    if (closed.length > 0) {
      await this.recordRevoke(tx, identity, "device", closed, { deviceId });
    }
    return closed;
  }

  /** A user's sessions in the request's org (org.session.read.org). */
  async listOfUser(userId: string): Promise<SessionData[]> {
    const identity = requireIdentity();
    assertCanReadOrg(identity);
    const rows = await this.runner.run((tx) =>
      this.repository.listOfUserInOrg(tx, userId, identity.orgId),
    );
    return this.present(identity, rows);
  }

  /** Closes a user's open sessions in the request's org (org.session.revoke.org). */
  async revokeOfUser(userId: string): Promise<string[]> {
    const identity = requireIdentity();
    assertCanRevokeOrg(identity);
    return this.runner.run(async (tx) => {
      const closed = await this.repository.closeInOrg(
        tx,
        userId,
        identity.orgId,
        this.now(),
      );
      if (closed.length > 0) {
        await this.recordRevoke(tx, identity, "admin", closed, { userId });
      }
      return closed.map((s) => s.id);
    });
  }

  /** Binds the caller's current session to `deviceId` (device registration). */
  bindCurrentSession(
    tx: Tx,
    identity: Identity,
    deviceId: string,
  ): Promise<boolean> {
    return this.repository.bindDevice(tx, identity.sessionId, deviceId);
  }

  /** One outbox row per closed session, then the audit event (last). */
  private async recordRevoke(
    tx: Tx,
    identity: Identity,
    cause: RevokeCause,
    closed: readonly ClosedSession[],
    target: { sessionId?: string; deviceId?: string; userId?: string },
  ): Promise<void> {
    for (const session of closed) {
      const payload: SessionRevoked = {
        sessionId: session.id,
        userId: session.userId,
        orgId: session.orgId,
        keycloakSid: session.keycloakSid,
      };
      await this.outbox.enqueue(tx, SESSIONS_REVOKED, payload);
    }
    const [only] = closed;
    await this.audit.record(tx, {
      action: `${SUBJECT}.revoke`,
      entityType: SUBJECT,
      entityId: closed.length === 1 && only !== undefined ? only.id : undefined,
      after: {
        cause,
        actorSessionId: identity.sessionId,
        ...target,
        sessions: closed.map((s) => ({
          id: s.id,
          orgId: s.orgId,
          userId: s.userId,
        })),
      },
    });
  }
}
