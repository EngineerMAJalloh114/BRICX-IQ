// The memberships module (P5-05, ADR 0066): its controllers, service and
// repository. Elevations end through @bricx/db/access-grants. Roles (their repository), audit, outbox and sessions come
// through their modules' public APIs (CLAUDE.md rule 13); TxRunner, CLOCK
// and the logger are global. P6-05: the project's state and its open
// sites through the projects module's ProjectsReader.
import { endAccessGrantsOf } from "@bricx/db/access-grants";
import { revokePendingInvitations } from "@bricx/db/invitations";
import { cancelPendingTransfers } from "@bricx/db/ownership";
import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/public-api.js";
import { OutboxModule } from "../outbox/public-api.js";
import { ProjectsModule } from "../projects/public-api.js";
import { RolesModule } from "../roles/public-api.js";
import { SessionsModule } from "../sessions/public-api.js";
import {
  MembersController,
  MyMembershipsController,
  ProjectMembersController,
} from "./memberships.controller.js";
import { MemberActivityService } from "./member-activity.service.js";
import { MembershipsRepository } from "./memberships.repository.js";
import { INVITATION_REVOKER } from "../../common/db/invitation-revoker.js";
import { OWNERSHIP_CANCELLER } from "../../common/db/ownership-canceller.js";
import {
  ACCESS_GRANT_ENDER,
  MembershipsService,
} from "./memberships.service.js";

@Module({
  imports: [
    AuditModule,
    OutboxModule,
    ProjectsModule,
    RolesModule,
    SessionsModule,
  ],
  controllers: [
    MembersController,
    ProjectMembersController,
    MyMembershipsController,
  ],
  providers: [
    MembershipsService,
    MembershipsRepository,
    // P6-06b (ADR 0084): a member's activity, read through the audit
    // module's AuditActivityReader.
    MemberActivityService,
    // A removal ends the member's elevations through @bricx/db (P5-07,
    // rule 13), never by writing the access-grants table here.
    { provide: ACCESS_GRANT_ENDER, useValue: endAccessGrantsOf },
    // P6-06 (ADR 0077, D14): a removal revokes the member's pending
    // invitations through @bricx/db, never through the invitations module.
    { provide: INVITATION_REVOKER, useValue: revokePendingInvitations },
    // P6-06c (ADR 0085): a party's change cancels a pending ownership
    // transfer through @bricx/db, never through that module.
    { provide: OWNERSHIP_CANCELLER, useValue: cancelPendingTransfers },
  ],
  // The repository too: the access-grants module (P5-06) checks a user's
  // open memberships through it rather than reading the tables itself.
  exports: [MembershipsService, MembershipsRepository],
})
export class MembershipsModule {}
