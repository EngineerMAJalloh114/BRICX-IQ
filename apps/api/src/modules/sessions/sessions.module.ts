// The sessions module (P5-03, ADR 0063): its controllers, service and
// repository. Audit and outbox come through their modules' public APIs
// (CLAUDE.md rule 13); TxRunner and CLOCK are global.
import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/public-api.js";
import { OutboxModule } from "../outbox/public-api.js";
import {
  SessionsController,
  UserSessionsController,
} from "./sessions.controller.js";
import { SessionsRepository } from "./sessions.repository.js";
import { SessionsService } from "./sessions.service.js";

@Module({
  imports: [AuditModule, OutboxModule],
  controllers: [SessionsController, UserSessionsController],
  providers: [SessionsService, SessionsRepository],
  exports: [SessionsService],
})
export class SessionsModule {}
