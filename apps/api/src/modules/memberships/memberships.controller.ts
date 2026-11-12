// Memberships' routes (P5-05, ADR 0066; plan 3.6), under /v1:
//   GET    /members                      the org's open memberships (org.member.read.org)
//   PATCH  /members/:id                  a new role                  (org.member.update.org)
//   DELETE /members/:id                  remove (204): closes project rows and sessions (org.member.remove.org)
//   GET    /projects/:projectId/members  the project's open memberships (project.member.read, org or that project)
//   POST   /projects/:projectId/members  @Idempotent() assign (201)  (project.member.assign, org or that project)
//   PATCH  /projects/:projectId/members/:id  a new role and/or overrides
//   DELETE /projects/:projectId/members/:id  unassign (204)
//   GET    /me/memberships               the caller's open org memberships in every org (no grant)
// P6-06b (ADR 0084), the member lifecycle:
//   GET    /members?expiringWithinDays=N temporary memberships ending within N days (1..90)
//   POST   /members/:id/suspend          suspend (200): sessions, grants, sent invitations end (org.member.update.org)
//   POST   /members/:id/reactivate       end the suspension (200); sessions do not come back
//   POST   /members/:id/renew            a new end on a temporary membership, with a reason
//   GET    /members/:id/activity         the member's audit events, a fixed projection (org.audit.read.org)
//   POST   /projects/:projectId/members/:id/suspend | reactivate | renew  (project.member.assign)
// P6-06 (ADR 0077, G2, owner condition C9): POST /members (adding an
// existing user by id) is retired; a person joins an org only by accepting
// an invitation (POST /v1/invitations).
// The handlers only parse and delegate.
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ZodResponse } from "nestjs-zod";
import { RateLimit } from "../../common/rate-limit/rate-limit.decorator.js";
import { Can, NoPermission } from "../../common/auth/can.decorator.js";
import { Idempotent } from "../../common/idempotency/decorator.js";
import {
  ActivityQuery,
  AssignProjectMember,
  Member,
  MemberActivity,
  MemberList,
  MemberListQuery,
  MemberParams,
  MyMembershipList,
  ProjectMember,
  ProjectMemberList,
  ProjectMemberParams,
  ProjectParams,
  RenewMember,
  SuspendMember,
  UpdateMember,
  UpdateProjectMember,
} from "./memberships.dto.js";
import {
  MemberActivityService,
  type MemberActivityPort,
} from "./member-activity.service.js";
import {
  MembershipsService,
  type MembershipsPort,
} from "./memberships.service.js";

@Controller({ path: "members", version: "1" })
export class MembersController {
  constructor(
    @Inject(MembershipsService) private readonly service: MembershipsPort,
    @Inject(MemberActivityService)
    private readonly activityOf: MemberActivityPort,
  ) {}

  @Get()
  @Can("org.member.read")
  @ZodResponse({ status: 200, type: MemberList })
  async list(@Query() query: MemberListQuery) {
    return { items: await this.service.list(query) };
  }

  @Post(":id/suspend")
  @Can("org.member.update")
  @HttpCode(200)
  @ZodResponse({ status: 200, type: Member })
  suspend(@Param() params: MemberParams, @Body() body: SuspendMember) {
    return this.service.suspend(params.id, body);
  }

  @Post(":id/reactivate")
  @Can("org.member.update")
  @HttpCode(200)
  @ZodResponse({ status: 200, type: Member })
  reactivate(@Param() params: MemberParams) {
    return this.service.reactivate(params.id);
  }

  @Post(":id/renew")
  @Can("org.member.update")
  @HttpCode(200)
  @ZodResponse({ status: 200, type: Member })
  renew(@Param() params: MemberParams, @Body() body: RenewMember) {
    return this.service.renew(params.id, body);
  }

  @Get(":id/activity")
  @Can("org.audit.read")
  @ZodResponse({ status: 200, type: MemberActivity })
  activity(@Param() params: MemberParams, @Query() query: ActivityQuery) {
    return this.activityOf.list(params.id, query);
  }

  @Patch(":id")
  @Can("org.member.update")
  @ZodResponse({ status: 200, type: Member })
  update(@Param() params: MemberParams, @Body() body: UpdateMember) {
    return this.service.update(params.id, body);
  }

  @Delete(":id")
  @Can("org.member.remove")
  @HttpCode(204)
  remove(@Param() params: MemberParams) {
    return this.service.remove(params.id);
  }
}

@Controller({ path: "projects/:projectId/members", version: "1" })
export class ProjectMembersController {
  constructor(
    @Inject(MembershipsService) private readonly service: MembershipsPort,
  ) {}

  @Get()
  @Can("project.member.read", { projectParam: "projectId" })
  @ZodResponse({ status: 200, type: ProjectMemberList })
  async list(@Param() params: ProjectParams) {
    return { items: await this.service.listProject(params.projectId) };
  }

  @Post()
  @RateLimit("invitation")
  @Can("project.member.assign", { projectParam: "projectId" })
  @Idempotent()
  @ZodResponse({ status: 201, type: ProjectMember })
  assign(@Param() params: ProjectParams, @Body() body: AssignProjectMember) {
    return this.service.assign(params.projectId, body);
  }

  @Patch(":id")
  @Can("project.member.assign", { projectParam: "projectId" })
  @ZodResponse({ status: 200, type: ProjectMember })
  update(
    @Param() params: ProjectMemberParams,
    @Body() body: UpdateProjectMember,
  ) {
    return this.service.updateProject(params.projectId, params.id, body);
  }

  @Post(":id/suspend")
  @Can("project.member.assign", { projectParam: "projectId" })
  @HttpCode(200)
  @ZodResponse({ status: 200, type: ProjectMember })
  suspend(@Param() params: ProjectMemberParams, @Body() body: SuspendMember) {
    return this.service.suspendProject(params.projectId, params.id, body);
  }

  @Post(":id/reactivate")
  @Can("project.member.assign", { projectParam: "projectId" })
  @HttpCode(200)
  @ZodResponse({ status: 200, type: ProjectMember })
  reactivate(@Param() params: ProjectMemberParams) {
    return this.service.reactivateProject(params.projectId, params.id);
  }

  @Post(":id/renew")
  @Can("project.member.assign", { projectParam: "projectId" })
  @HttpCode(200)
  @ZodResponse({ status: 200, type: ProjectMember })
  renew(@Param() params: ProjectMemberParams, @Body() body: RenewMember) {
    return this.service.renewProject(params.projectId, params.id, body);
  }

  @Delete(":id")
  @Can("project.member.assign", { projectParam: "projectId" })
  @HttpCode(204)
  unassign(@Param() params: ProjectMemberParams) {
    return this.service.unassign(params.projectId, params.id);
  }
}

@Controller({ path: "me/memberships", version: "1" })
export class MyMembershipsController {
  constructor(
    @Inject(MembershipsService) private readonly service: MembershipsPort,
  ) {}

  @Get()
  @NoPermission("the caller's own memberships, every org")
  @ZodResponse({ status: 200, type: MyMembershipList })
  async list() {
    return { items: await this.service.listMine() };
  }
}
