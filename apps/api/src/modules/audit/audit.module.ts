// The audit module (P4-05, ADR 0055): AuditService, with the system Clock.
// Other modules import AuditModule and use AuditService through
// public-api.ts (CLAUDE.md rule 13).
import { Module } from "@nestjs/common";
import { CLOCK, systemClock } from "../../common/clock.js";
import { AuditService } from "./audit.service.js";

@Module({
  providers: [{ provide: CLOCK, useValue: systemClock }, AuditService],
  exports: [AuditService],
})
export class AuditModule {}
