// Projects' and sites' routes (P6-05, ADR 0075 D16), under /v1/projects:
//   POST  /                               create (201, @Idempotent)
//   GET   /                               a page of readable projects
//   GET   /:id                            one project
//   PATCH /:id                            change fields
//   POST  /:id/status { to }              move the status (C3)
//   POST  /:projectId/sites               create a site (201, @Idempotent)
//   GET   /:projectId/sites               a page of readable sites
//   GET   /:projectId/sites/:id           one site
//   PATCH /:projectId/sites/:id           change a site
//   POST  /:projectId/sites/:id/archive   archive a site
// Each @Can declares { anywhere: true } (ADR 0068): the guard checks the
// action is held somewhere in the org; the service checks the record, so
// a project or site the caller may not read is 404 like an unknown one
// (C5) and one they read but may not change is 403. Reads of a site
// check project.project.read at the guard: a site key alone may hold on
// no site (C4), and that answer is the service's 404. The handlers only
// parse and delegate.
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ZodResponse } from "nestjs-zod";
import { Can } from "../../common/auth/can.decorator.js";
import { Idempotent } from "../../common/idempotency/decorator.js";
import {
  CreateProject,
  ListProjectsQuery,
  MoveProject,
  Project,
  ProjectPage,
  ProjectParams,
  UpdateProject,
} from "./projects.dto.js";
import { ProjectsService, type ProjectsPort } from "./projects.service.js";
import {
  CreateSite,
  ListSitesQuery,
  ProjectSitesParams,
  Site,
  SitePage,
  SiteParams,
  UpdateSite,
} from "./sites.dto.js";
import { SitesService, type SitesPort } from "./sites.service.js";

@Controller({ path: "projects", version: "1" })
export class ProjectsController {
  constructor(
    @Inject(ProjectsService) private readonly service: ProjectsPort,
  ) {}

  @Post()
  @Can("project.project.create", { anywhere: true })
  @Idempotent()
  @ZodResponse({ status: 201, type: Project })
  create(@Body() body: CreateProject) {
    return this.service.create(body);
  }

  @Get()
  @Can("project.project.read", { anywhere: true })
  @ZodResponse({ status: 200, type: ProjectPage })
  list(@Query() query: ListProjectsQuery) {
    return this.service.list(query);
  }

  @Get(":id")
  @Can("project.project.read", { anywhere: true })
  @ZodResponse({ status: 200, type: Project })
  get(@Param() params: ProjectParams) {
    return this.service.get(params.id);
  }

  @Patch(":id")
  @Can("project.project.update", { anywhere: true })
  @ZodResponse({ status: 200, type: Project })
  update(@Param() params: ProjectParams, @Body() body: UpdateProject) {
    return this.service.update(params.id, body);
  }

  @Post(":id/status")
  @HttpCode(200)
  @Can("project.project.read", { anywhere: true })
  @ZodResponse({ status: 200, type: Project })
  move(@Param() params: ProjectParams, @Body() body: MoveProject) {
    return this.service.move(params.id, body.to);
  }
}

@Controller({ path: "projects/:projectId/sites", version: "1" })
export class SitesController {
  constructor(@Inject(SitesService) private readonly service: SitesPort) {}

  @Post()
  @Can("project.site.create", { anywhere: true })
  @Idempotent()
  @ZodResponse({ status: 201, type: Site })
  create(@Param() params: ProjectSitesParams, @Body() body: CreateSite) {
    return this.service.create(params.projectId, body);
  }

  @Get()
  @Can("project.project.read", { anywhere: true })
  @ZodResponse({ status: 200, type: SitePage })
  list(@Param() params: ProjectSitesParams, @Query() query: ListSitesQuery) {
    return this.service.list(params.projectId, query);
  }

  @Get(":id")
  @Can("project.project.read", { anywhere: true })
  @ZodResponse({ status: 200, type: Site })
  get(@Param() params: SiteParams) {
    return this.service.get(params.projectId, params.id);
  }

  @Patch(":id")
  @Can("project.site.update", { anywhere: true })
  @ZodResponse({ status: 200, type: Site })
  update(@Param() params: SiteParams, @Body() body: UpdateSite) {
    return this.service.update(params.projectId, params.id, body);
  }

  @Post(":id/archive")
  @HttpCode(200)
  @Can("project.site.archive", { anywhere: true })
  @ZodResponse({ status: 200, type: Site })
  archive(@Param() params: SiteParams) {
    return this.service.archive(params.projectId, params.id);
  }
}
