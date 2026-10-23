// The memberships module (P5-05, ADR 0066): its controllers, service and
// repository. Roles (their repository), audit, outbox and sessions come
// through their modules' public APIs (CLAUDE.md rule 13); TxRunner, CLOCK
// and the logger are global.
import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/public-api.js";
import { OutboxModule } from "../outbox/public-api.js";
import { RolesModule } from "../roles/public-api.js";
import { SessionsModule } from "../sessions/public-api.js";
import {
  MembersController,
  MyMembershipsController,
  ProjectMembersController,
} from "./memberships.controller.js";
import { MembershipsRepository } from "./memberships.repository.js";
import { MembershipsService } from "./memberships.service.js";

@Module({
  imports: [AuditModule, OutboxModule, RolesModule, SessionsModule],
  controllers: [
    MembersController,
    ProjectMembersController,
    MyMembershipsController,
  ],
  providers: [MembershipsService, MembershipsRepository],
  // The repository too: the access-grants module (P5-06) checks a user's
  // open memberships through it rather than reading the tables itself.
  exports: [MembershipsService, MembershipsRepository],
})
export class MembershipsModule {}
