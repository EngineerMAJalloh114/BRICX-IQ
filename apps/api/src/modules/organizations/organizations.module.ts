// The organisations module (P6-02, ADR 0072): its controller, service and
// repository, plus this cell's id (CELL_ID), the directory writer
// (DIRECTORY_WRITER_DATABASE_URL; absent, create answers 503) and the
// per-user create cap from config. Audit comes through the audit module's
// public API (CLAUDE.md rule 13). The writer is closed on shutdown.
import type { DirectoryWriter } from "@bricx/db/directory";
import { revokePendingInvitations } from "@bricx/db/invitations";
import {
  type DynamicModule,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { INVITATION_REVOKER } from "../../common/db/invitation-revoker.js";
import { AuditModule } from "../audit/public-api.js";
import { OrganizationsController } from "./organizations.controller.js";
import { OrganizationsRepository } from "./organizations.repository.js";
import {
  CELL_ID,
  ORGS_DIRECTORY_WRITER,
  ORGS_MAX_CREATED_PER_USER,
  OrganizationsService,
} from "./organizations.service.js";

export interface OrganizationsModuleOptions {
  /** `cellId` from the API config (CELL_ID). */
  readonly cellId: string;
  /** The directory_writer handle, or undefined (no writer configured). */
  readonly writer: DirectoryWriter | undefined;
  /** `organizations.maxCreatedPerUser` (ORGS_MAX_CREATED_PER_USER). */
  readonly maxCreatedPerUser: number;
}

class WriterLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(ORGS_DIRECTORY_WRITER)
    private readonly writer: DirectoryWriter | undefined,
  ) {}

  private readonly logger = new Logger("Organizations");

  async onApplicationShutdown() {
    if (this.writer === undefined) return;
    await this.writer.close();
    this.logger.log("directory writer closed");
  }
}

@Module({})
export class OrganizationsModule {
  static forRoot(options: OrganizationsModuleOptions): DynamicModule {
    return {
      module: OrganizationsModule,
      imports: [AuditModule],
      controllers: [OrganizationsController],
      providers: [
        OrganizationsService,
        OrganizationsRepository,
        WriterLifecycle,
        // P6-06 (ADR 0077, D14): an archive revokes every pending invitation.
        { provide: INVITATION_REVOKER, useValue: revokePendingInvitations },
        { provide: CELL_ID, useValue: options.cellId },
        // A factory: Nest reads a useValue of undefined as no provider.
        { provide: ORGS_DIRECTORY_WRITER, useFactory: () => options.writer },
        {
          provide: ORGS_MAX_CREATED_PER_USER,
          useValue: options.maxCreatedPerUser,
        },
      ],
    };
  }
}
