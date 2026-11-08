// ProjectsReader (P6-05, ADR 0075; owner conditions C2, C4, C9): what
// other modules ask of a project, through this module's public API
// (CLAUDE.md rule 13), in their own transaction (RLS applies):
// - stateOf(): the project's status, or undefined when the transaction
//   does not see it (unknown, another org's, outside the caller's
//   projects): the callers answer 404, an archived one 409;
// - openSiteIds(): of the given ids, the open (not archived) sites of that
//   project, sorted: a membership's siteIds and a site elevation's siteId
//   must be among them (422 unknown_site).
import type { Tx } from "@bricx/db/database";
import { Inject, Injectable } from "@nestjs/common";
import { ProjectsRepository } from "./projects.repository.js";

export interface ProjectState {
  readonly status: string;
}

@Injectable()
export class ProjectsReader {
  constructor(
    @Inject(ProjectsRepository)
    private readonly repository: ProjectsRepository,
  ) {}

  async stateOf(
    tx: Tx,
    orgId: string,
    projectId: string,
  ): Promise<ProjectState | undefined> {
    const row = await this.repository.findProject(tx, orgId, projectId);
    return row === undefined ? undefined : { status: row.status };
  }

  openSiteIds(
    tx: Tx,
    orgId: string,
    projectId: string,
    siteIds: readonly string[],
  ): Promise<string[]> {
    return this.repository.openSiteIds(tx, orgId, projectId, siteIds);
  }
}
