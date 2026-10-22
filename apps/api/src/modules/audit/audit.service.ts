// AuditService.record() (P4-05, ADR 0055): appends one event to the
// current org's hash chain, inside the caller's transaction (TxRunner or
// withTx), so the event commits or rolls back with the change it records.
// Since P5-06 (ADR 0067, owner condition 4) the recorder itself
// (validation, the per-org advisory lock, the READ COMMITTED check, the
// chain head, hash = sha256(prev ‖ JCS(row)), the INSERT) is
// @bricx/db/audit's recordAuditEvent(), shared with the worker's expiry
// consumer; this service adds what the API knows: the request's origin
// (correlation id, ip, device, geo) and the actor `user`
// (app.current_user_id()). The lock is held until COMMIT, so record() is
// the last statement of the request transaction (ADR 0055): anything after
// it lengthens the time other writers in the org wait.
import {
  AUDIT_LOCK_NAMESPACE,
  type AuditEventInput,
  type AuditOriginInput,
  type RecordedAuditEvent,
  recordAuditEvent,
} from "@bricx/db/audit";
import { type Tx } from "@bricx/db/database";
import {
  createUuidV7Generator,
  type UuidV7Generator,
} from "@bricx/ids/uuid-v7";
import { Inject, Injectable } from "@nestjs/common";
import { CLOCK, type Clock } from "../../common/clock.js";
import { currentRequestContext } from "../../common/db/request-context.js";

export { AUDIT_LOCK_NAMESPACE, type RecordedAuditEvent };

@Injectable()
export class AuditService {
  private readonly ids: UuidV7Generator;

  constructor(@Inject(CLOCK) private readonly clock: Clock) {
    this.ids = createUuidV7Generator({ clock });
  }

  /**
   * Appends `event` to the org's chain in `tx`. `origin` defaults to the
   * current request's (correlation id, ip, device, geo); outside a request,
   * to a fresh UUIDv7 correlation id and nothing else.
   */
  record(
    tx: Tx,
    event: AuditEventInput,
    origin?: AuditOriginInput,
  ): Promise<RecordedAuditEvent> {
    return recordAuditEvent(
      tx,
      { clock: this.clock, ids: this.ids, actor: "user" },
      event,
      origin ?? this.requestOrigin(),
    );
  }

  private requestOrigin(): AuditOriginInput {
    const context = currentRequestContext();
    if (context === undefined) return { correlationId: this.ids.next() };
    return {
      correlationId: context.correlationId,
      ip: context.ip,
      deviceId: context.deviceId,
      geo: context.geo,
    };
  }
}
