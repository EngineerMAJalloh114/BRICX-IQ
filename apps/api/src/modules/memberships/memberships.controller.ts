// Memberships' routes (P5-05, ADR 0066; plan 3.6), under /v1:
//   GET    /members                      the org's open memberships (org.member.read.org)
//   POST   /members                      @Idempotent() invite (201)  (org.member.invite.org)
//   PATCH  /members/:id                  a new role                  (org.member.update.org)
//   DELETE /members/:id                  remove (204): closes project rows and sessions (org.member.remove.org)
//   GET    /projects/:projectId/members  the project's open memberships (project.member.read, org or that project)
//   POST   /projects/:projectId/members  @Idempotent() assign (201)  (project.member.assign, org or that project)
//   PATCH  /projects/:projectId/members/:id  a new role and/or overrides
//   DELETE /projects/:projectId/members/:id  unassign (204)
//   GET    /me/memberships               the caller's open org memberships in every org (no grant)
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
} from "@nestjs/common";
import { ZodResponse } from "nestjs-zod";
import { Idempotent } from "../../common/idempotency/decorator.js";
import {
  AssignProjectMember,
  CreateMember,
  Member,
  MemberList,
  MemberParams,
  MyMembershipList,
  ProjectMember,
  ProjectMemberList,
  ProjectMemberParams,
  ProjectParams,
  UpdateMember,
  UpdateProjectMember,
} from "./memberships.dto.js";
import {
  MembershipsService,
  type MembershipsPort,
} from "./memberships.service.js";

@Controller({ path: "members", version: "1" })
export class MembersController {
  constructor(
    @Inject(MembershipsService) private readonly service: MembershipsPort,
  ) {}

  @Get()
  @ZodResponse({ status: 200, type: MemberList })
  async list() {
    return { items: await this.service.list() };
  }

  @Post()
  @Idempotent()
  @ZodResponse({ status: 201, type: Member })
  invite(@Body() body: CreateMember) {
    return this.service.invite(body);
  }

  @Patch(":id")
  @ZodResponse({ status: 200, type: Member })
  update(@Param() params: MemberParams, @Body() body: UpdateMember) {
    return this.service.update(params.id, body);
  }

  @Delete(":id")
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
  @ZodResponse({ status: 200, type: ProjectMemberList })
  async list(@Param() params: ProjectParams) {
    return { items: await this.service.listProject(params.projectId) };
  }

  @Post()
  @Idempotent()
  @ZodResponse({ status: 201, type: ProjectMember })
  assign(@Param() params: ProjectParams, @Body() body: AssignProjectMember) {
    return this.service.assign(params.projectId, body);
  }

  @Patch(":id")
  @ZodResponse({ status: 200, type: ProjectMember })
  update(
    @Param() params: ProjectMemberParams,
    @Body() body: UpdateProjectMember,
  ) {
    return this.service.updateProject(params.projectId, params.id, body);
  }

  @Delete(":id")
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
  @ZodResponse({ status: 200, type: MyMembershipList })
  async list() {
    return { items: await this.service.listMine() };
  }
}
