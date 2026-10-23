// Roles' routes (P5-05, ADR 0066), under /v1/roles:
//   GET   /             the org's open roles with their keys (org.role.read.org)
//   POST  /             @Idempotent() create (201)      (org.role.manage.org)
//   GET   /:id          one open role (404 otherwise)
//   PATCH /:id          a new name and/or bundle; the owner role is 409
//   POST  /:id/archive  @Idempotent() archive; in use or the owner role is 409
// The handlers only parse and delegate.
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { ZodResponse } from "nestjs-zod";
import { Can } from "../../common/auth/can.decorator.js";
import { Idempotent } from "../../common/idempotency/decorator.js";
import {
  CreateRole,
  Role,
  RoleList,
  RoleParams,
  UpdateRole,
} from "./roles.dto.js";
import { RolesService, type RolesPort } from "./roles.service.js";

@Controller({ path: "roles", version: "1" })
export class RolesController {
  constructor(@Inject(RolesService) private readonly service: RolesPort) {}

  @Get()
  @Can("org.role.read")
  @ZodResponse({ status: 200, type: RoleList })
  async list() {
    return { items: await this.service.list() };
  }

  @Post()
  @Can("org.role.manage")
  @Idempotent()
  @ZodResponse({ status: 201, type: Role })
  create(@Body() body: CreateRole) {
    return this.service.create(body);
  }

  @Get(":id")
  @Can("org.role.read")
  @ZodResponse({ status: 200, type: Role })
  get(@Param() params: RoleParams) {
    return this.service.get(params.id);
  }

  @Patch(":id")
  @Can("org.role.manage")
  @ZodResponse({ status: 200, type: Role })
  update(@Param() params: RoleParams, @Body() body: UpdateRole) {
    return this.service.update(params.id, body);
  }

  @Post(":id/archive")
  @Can("org.role.manage")
  @Idempotent()
  @HttpCode(200)
  @ZodResponse({ status: 200, type: Role })
  archive(@Param() params: RoleParams) {
    return this.service.archive(params.id);
  }
}
