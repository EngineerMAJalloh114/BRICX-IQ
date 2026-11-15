// The invitation-batches module (P6-06c, ADR 0085): its controller,
// service and repository. A row runs the single invite's own checks
// through the invitations module's exported InvitationsService
// (checkRow); forRoot() takes the very InvitationsModule the app
// registers, so both share one instance. Roles, audit and outbox come
// through their modules' public APIs (CLAUDE.md rule 13); TxRunner, CLOCK
// and the denial recorder are global.
import { type DynamicModule, Module } from "@nestjs/common";
import { AuditModule } from "../audit/public-api.js";
import { OutboxModule } from "../outbox/public-api.js";
import { RolesModule } from "../roles/public-api.js";
import { InvitationBatchesController } from "./invitation-batches.controller.js";
import { InvitationBatchesRepository } from "./invitation-batches.repository.js";
import { InvitationBatchesService } from "./invitation-batches.service.js";

@Module({})
export class InvitationBatchesModule {
  /** `invitations`: the InvitationsModule.forRoot() the app imports. */
  static forRoot(invitations: DynamicModule): DynamicModule {
    return {
      module: InvitationBatchesModule,
      imports: [AuditModule, invitations, OutboxModule, RolesModule],
      controllers: [InvitationBatchesController],
      providers: [InvitationBatchesService, InvitationBatchesRepository],
    };
  }
}
