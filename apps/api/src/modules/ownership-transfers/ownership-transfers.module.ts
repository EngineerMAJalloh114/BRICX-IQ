// The ownership-transfers module (P6-06c, ADR 0085): its controller,
// service and repository. Memberships (its repository: accept writes the
// two role changes through it, under its org lock), roles, audit and
// outbox come through their modules' public APIs (CLAUDE.md rule 13);
// TxRunner, CLOCK and the denial recorder are global. The cascades live in
// @bricx/db/ownership (OWNERSHIP_CANCELLER), so no module imports this one.
import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/public-api.js";
import { MembershipsModule } from "../memberships/public-api.js";
import { OutboxModule } from "../outbox/public-api.js";
import { RolesModule } from "../roles/public-api.js";
import { OwnershipTransfersController } from "./ownership-transfers.controller.js";
import { OwnershipTransfersRepository } from "./ownership-transfers.repository.js";
import { OwnershipTransfersService } from "./ownership-transfers.service.js";

@Module({
  imports: [AuditModule, MembershipsModule, OutboxModule, RolesModule],
  controllers: [OwnershipTransfersController],
  providers: [OwnershipTransfersService, OwnershipTransfersRepository],
})
export class OwnershipTransfersModule {}
