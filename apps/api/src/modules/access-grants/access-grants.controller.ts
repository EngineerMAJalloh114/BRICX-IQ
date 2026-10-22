// Access grants' routes (P5-06, ADR 0067), under /v1:
//   GET    /access-grants          the org's open grants, newest first (org.access_grant.read.org; ?userId=)
//   POST   /access-grants          @Idempotent() grant (201)         (org.access_grant.grant.org)
//   GET    /access-grants/:id      one grant, whatever its state      (org.access_grant.read.org)
//   DELETE /access-grants/:id      revoke (204)                       (org.access_grant.revoke.org)
//   GET    /me/access-grants       the caller's active grants in the org (no grant)
// The handlers only parse and delegate.
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ZodResponse } from "nestjs-zod";
import { Idempotent } from "../../common/idempotency/decorator.js";
import {
  AccessGrant,
  AccessGrantList,
  AccessGrantParams,
  CreateAccessGrant,
  ListAccessGrantsQuery,
} from "./access-grants.dto.js";
import {
  AccessGrantsService,
  type AccessGrantsPort,
} from "./access-grants.service.js";

@Controller({ path: "access-grants", version: "1" })
export class AccessGrantsController {
  constructor(
    @Inject(AccessGrantsService) private readonly service: AccessGrantsPort,
  ) {}

  @Get()
  @ZodResponse({ status: 200, type: AccessGrantList })
  async list(@Query() query: ListAccessGrantsQuery) {
    return { items: await this.service.list(query) };
  }

  @Post()
  @Idempotent()
  @ZodResponse({ status: 201, type: AccessGrant })
  grant(@Body() body: CreateAccessGrant) {
    return this.service.grant(body);
  }

  @Get(":id")
  @ZodResponse({ status: 200, type: AccessGrant })
  get(@Param() params: AccessGrantParams) {
    return this.service.get(params.id);
  }

  @Delete(":id")
  @HttpCode(204)
  revoke(@Param() params: AccessGrantParams) {
    return this.service.revoke(params.id);
  }
}

@Controller({ path: "me/access-grants", version: "1" })
export class MyAccessGrantsController {
  constructor(
    @Inject(AccessGrantsService) private readonly service: AccessGrantsPort,
  ) {}

  @Get()
  @ZodResponse({ status: 200, type: AccessGrantList })
  async list() {
    return { items: await this.service.listMine() };
  }
}
