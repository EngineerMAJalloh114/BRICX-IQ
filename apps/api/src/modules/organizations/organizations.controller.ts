// Organisations' routes (P6-02, ADR 0072), under /v1/organizations:
//   POST /                 @SignedIn() create one (201; Idempotency-Key
//                          required, the service handles it: D12)
//   GET  /current          the request's organisation, archived or not
//                          (@AllowArchivedOrg, D6/D16)
//   PATCH /current         change its editable fields (D5: not the slug)
//   POST /current/archive  archive it, one way (org.organization.archive,
//                          owner only: owner condition C3)
// The handlers only parse and delegate.
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Patch,
  Post,
} from "@nestjs/common";
import { ApiHeader } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";
import { RateLimit } from "../../common/rate-limit/rate-limit.decorator.js";
import { AllowArchivedOrg } from "../../common/auth/allow-archived-org.decorator.js";
import { Can } from "../../common/auth/can.decorator.js";
import { SignedIn } from "../../common/auth/signed-in.decorator.js";
import { IDEMPOTENCY_KEY_HEADER } from "../../common/idempotency/decorator.js";
import {
  CreateOrganization,
  Organization,
  UpdateOrganization,
} from "./organizations.dto.js";
import {
  OrganizationsService,
  type OrganizationsPort,
} from "./organizations.service.js";

@Controller({ path: "organizations", version: "1" })
export class OrganizationsController {
  constructor(
    @Inject(OrganizationsService) private readonly service: OrganizationsPort,
  ) {}

  @Post()
  @RateLimit("auth_adjacent")
  @SignedIn()
  @ApiHeader({ name: IDEMPOTENCY_KEY_HEADER, required: true })
  @ZodResponse({ status: 201, type: Organization })
  create(
    @Body() body: CreateOrganization,
    @Headers(IDEMPOTENCY_KEY_HEADER) key: string | undefined,
  ) {
    return this.service.create(body, key);
  }

  @Get("current")
  @Can("org.organization.read")
  @AllowArchivedOrg()
  @ZodResponse({ status: 200, type: Organization })
  current() {
    return this.service.readCurrent();
  }

  @Patch("current")
  @Can("org.organization.update")
  @ZodResponse({ status: 200, type: Organization })
  update(@Body() body: UpdateOrganization) {
    return this.service.updateCurrent(body);
  }

  @Post("current/archive")
  @Can("org.organization.archive")
  @HttpCode(200)
  @ZodResponse({ status: 200, type: Organization })
  archive() {
    return this.service.archiveCurrent();
  }
}
