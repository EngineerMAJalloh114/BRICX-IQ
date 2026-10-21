// Devices' service (P5-03, ADR 0063). Register: the X-Device-Id header must
// name the body's id (the guard let an unregistered header through on this
// one route, @RegistersDevice()); the row is inserted (an existing row of
// the caller's with that id is returned unchanged: idempotent by id;
// another user's id is 409 request.conflict), the current session is bound
// to the device, and one org.device.register audit event (ids only) goes
// in the request's org chain (owner condition 6). List: the caller's
// devices. Revoke: revoked_at on the caller's device and, in the same
// transaction, every open session of theirs on it in every org (the
// sessions module writes the outbox rows and the audit event), plus one
// org.device.revoke audit event.
import { Inject, Injectable } from "@nestjs/common";
import { CLOCK, type Clock } from "../../common/clock.js";
import { currentRequestContext } from "../../common/db/request-context.js";
import { TxRunner } from "../../common/db/tx-runner.js";
import { ApiError } from "../../common/errors/api-error.js";
import { AuditService } from "../audit/public-api.js";
import {
  type AuditRecorder,
  type SessionsOfDevicePort,
  SessionsService,
  type TransactionRunner,
  requireIdentity,
} from "../sessions/public-api.js";
import type { DeviceData, PLATFORMS } from "./devices.dto.js";
import { DevicesRepository } from "./devices.repository.js";

/** The audit entity type (no catalogue resource: devices have no administrator path). */
export const DEVICE_ENTITY = "org.device";

export interface RegisterDeviceInput {
  readonly id: string;
  readonly platform: (typeof PLATFORMS)[number];
  readonly name: string;
}

/** What the controller calls. */
export type DevicesPort = Pick<
  DevicesService,
  "register" | "listMine" | "revoke"
>;

@Injectable()
export class DevicesService {
  constructor(
    @Inject(TxRunner) private readonly runner: TransactionRunner,
    @Inject(DevicesRepository) private readonly repository: DevicesRepository,
    @Inject(SessionsService) private readonly sessions: SessionsOfDevicePort,
    @Inject(AuditService) private readonly audit: AuditRecorder,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private now(): string {
    return new Date(this.clock.now()).toISOString();
  }

  async register(input: RegisterDeviceInput): Promise<DeviceData> {
    const identity = requireIdentity();
    // The header named the device being registered, and only that one.
    if (currentRequestContext()?.deviceId !== input.id) {
      throw new ApiError("request.malformed");
    }
    return this.runner.run(async (tx) => {
      const existing = await this.repository.findById(tx, input.id);
      if (existing !== undefined) {
        if (existing.revokedAt !== null) throw new ApiError("request.conflict");
        await this.sessions.bindCurrentSession(tx, identity, existing.id);
        return existing;
      }
      const device = await this.repository.insert(tx, {
        id: input.id,
        userId: identity.userId,
        platform: input.platform,
        name: input.name,
        now: this.now(),
      });
      await this.sessions.bindCurrentSession(tx, identity, device.id);
      await this.audit.record(tx, {
        action: `${DEVICE_ENTITY}.register`,
        entityType: DEVICE_ENTITY,
        entityId: device.id,
        after: { userId: identity.userId, sessionId: identity.sessionId },
      });
      return device;
    });
  }

  listMine(): Promise<DeviceData[]> {
    requireIdentity();
    return this.runner.run((tx) => this.repository.listMine(tx));
  }

  /** Revokes the caller's device `id` and its sessions; 404 when not theirs. */
  async revoke(id: string): Promise<void> {
    const identity = requireIdentity();
    await this.runner.run(async (tx) => {
      const revoked = await this.repository.revoke(tx, id, this.now());
      if (!revoked) {
        const existing = await this.repository.findById(tx, id);
        if (existing === undefined) throw new ApiError("not_found");
        return; // already revoked: idempotent
      }
      const closed = await this.sessions.revokeOnDevice(tx, identity, id);
      await this.audit.record(tx, {
        action: `${DEVICE_ENTITY}.revoke`,
        entityType: DEVICE_ENTITY,
        entityId: id,
        after: {
          userId: identity.userId,
          sessions: closed.map((s) => ({ id: s.id, orgId: s.orgId })),
        },
      });
    });
  }
}
