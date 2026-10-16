// The outbox module (P4-06, ADR 0056): OutboxService, with the system
// Clock. Other modules import OutboxModule and use OutboxService through
// public-api.ts (CLAUDE.md rule 13).
import { Module } from "@nestjs/common";
import { CLOCK, systemClock } from "../../common/clock.js";
import { OutboxService } from "./outbox.service.js";

@Module({
  providers: [{ provide: CLOCK, useValue: systemClock }, OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
