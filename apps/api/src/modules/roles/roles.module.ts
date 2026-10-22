// The roles module (P5-05, ADR 0066): its controller, service and
// repository. Audit and outbox come through their modules' public APIs
// (CLAUDE.md rule 13); TxRunner, CLOCK and the logger are global.
import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/public-api.js";
import { OutboxModule } from "../outbox/public-api.js";
import { RolesController } from "./roles.controller.js";
import { RolesRepository } from "./roles.repository.js";
import { RolesService } from "./roles.service.js";

@Module({
  imports: [AuditModule, OutboxModule],
  controllers: [RolesController],
  providers: [RolesService, RolesRepository],
  exports: [RolesService],
})
export class RolesModule {}
