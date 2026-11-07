// Region configuration's routes (P6-03, ADR 0073), under /v1/region-config.
// Every route checks an org-scope key (owner condition C4), the project
// routes included:
//   GET   /effective?projectId=     the effective config with provenance
//   GET   /                         the org row (org.region_config.read)
//   PATCH /                         change it (org.region_config.update)
//   GET   /projects/:projectId      a project's row
//   PATCH /projects/:projectId      change it
// The handlers only parse and delegate.
import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Query,
} from "@nestjs/common";
import { ZodResponse } from "nestjs-zod";
import { Can } from "../../common/auth/can.decorator.js";
import {
  EffectiveRegionConfig,
  EffectiveRegionConfigQuery,
  ProjectRegionConfigParams,
  RegionConfigLayer,
  UpdateOrgRegionConfig,
  UpdateProjectRegionConfig,
} from "./region-config.dto.js";
import {
  RegionConfigService,
  type RegionConfigPort,
} from "./region-config.service.js";

@Controller({ path: "region-config", version: "1" })
export class RegionConfigController {
  constructor(
    @Inject(RegionConfigService) private readonly service: RegionConfigPort,
  ) {}

  @Get("effective")
  @Can("org.region_config.read")
  @ZodResponse({ status: 200, type: EffectiveRegionConfig })
  effective(@Query() query: EffectiveRegionConfigQuery) {
    return this.service.readEffective(query.projectId);
  }

  @Get()
  @Can("org.region_config.read")
  @ZodResponse({ status: 200, type: RegionConfigLayer })
  org() {
    return this.service.readLayer(null);
  }

  @Patch()
  @Can("org.region_config.update")
  @ZodResponse({ status: 200, type: RegionConfigLayer })
  updateOrg(@Body() body: UpdateOrgRegionConfig) {
    return this.service.updateLayer(null, body);
  }

  @Get("projects/:projectId")
  @Can("org.region_config.read")
  @ZodResponse({ status: 200, type: RegionConfigLayer })
  project(@Param() params: ProjectRegionConfigParams) {
    return this.service.readLayer(params.projectId);
  }

  @Patch("projects/:projectId")
  @Can("org.region_config.update")
  @ZodResponse({ status: 200, type: RegionConfigLayer })
  updateProject(
    @Param() params: ProjectRegionConfigParams,
    @Body() body: UpdateProjectRegionConfig,
  ) {
    return this.service.updateLayer(params.projectId, body);
  }
}
