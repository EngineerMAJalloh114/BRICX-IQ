// The projects module (P6-05, ADR 0075): projects and their sites, their
// controllers, services and repository, and the ProjectsReader the
// memberships, access-grants and region-config modules ask through this
// module's public API (CLAUDE.md rule 13). Audit comes through its
// module's public API; TxRunner and CLOCK are global.
import { revokePendingInvitations } from "@bricx/db/invitations";
import { Module } from "@nestjs/common";
import { INVITATION_REVOKER } from "../../common/db/invitation-revoker.js";
import { AuditModule } from "../audit/public-api.js";
import { ProjectsController, SitesController } from "./projects.controller.js";
import { ProjectsReader } from "./projects.reader.js";
import { ProjectsRepository } from "./projects.repository.js";
import { ProjectsService } from "./projects.service.js";
import { SitesService } from "./sites.service.js";

@Module({
  imports: [AuditModule],
  controllers: [ProjectsController, SitesController],
  providers: [
    ProjectsService,
    SitesService,
    ProjectsRepository,
    ProjectsReader,
    // P6-06 (ADR 0077, D14): an archive revokes the project's invitations.
    { provide: INVITATION_REVOKER, useValue: revokePendingInvitations },
  ],
  exports: [ProjectsReader],
})
export class ProjectsModule {}
