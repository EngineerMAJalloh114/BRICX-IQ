// The invitations module (P6-06, ADR 0077): its controller, service and
// repository, plus this cell's id (CELL_ID: a token for another cell is
// refused), the resend cap (INVITATION_MAX_RESENDS) and the userinfo
// client (auth.userinfoUrl, C3). Memberships (its repository: accept
// writes through it), roles, projects, audit and outbox come through
// their modules' public APIs (CLAUDE.md rule 13); TxRunner, CLOCK and the
// denial recorder are global.
import { type DynamicModule, Module } from "@nestjs/common";
import { AuditModule } from "../audit/public-api.js";
import { MembershipsModule } from "../memberships/public-api.js";
import { OutboxModule } from "../outbox/public-api.js";
import { ProjectsModule } from "../projects/public-api.js";
import { RolesModule } from "../roles/public-api.js";
import { InvitationsController } from "./invitations.controller.js";
import { InvitationsRepository } from "./invitations.repository.js";
import {
  INVITATIONS_CELL_ID,
  INVITATIONS_MAX_RESENDS,
  InvitationsService,
} from "./invitations.service.js";
import {
  USERINFO_CLIENT,
  type UserinfoClient,
  createUserinfoClient,
} from "./userinfo.js";

export interface InvitationsModuleOptions {
  /** `cellId` from the API config (CELL_ID). */
  readonly cellId: string;
  /** `invitations.maxResends` (INVITATION_MAX_RESENDS). */
  readonly maxResends: number;
  /** `auth.userinfoUrl`, derived from KEYCLOAK_ISSUER (C3). */
  readonly userinfoUrl: string;
  /** Tests only: a userinfo client without Keycloak. */
  readonly userinfo?: UserinfoClient | undefined;
}

@Module({})
export class InvitationsModule {
  static forRoot(options: InvitationsModuleOptions): DynamicModule {
    return {
      module: InvitationsModule,
      imports: [
        AuditModule,
        MembershipsModule,
        OutboxModule,
        ProjectsModule,
        RolesModule,
      ],
      controllers: [InvitationsController],
      providers: [
        InvitationsService,
        InvitationsRepository,
        { provide: INVITATIONS_CELL_ID, useValue: options.cellId },
        { provide: INVITATIONS_MAX_RESENDS, useValue: options.maxResends },
        {
          provide: USERINFO_CLIENT,
          useValue:
            options.userinfo ??
            createUserinfoClient({ url: options.userinfoUrl }),
        },
      ],
      // P6-06c (ADR 0085): the bulk module runs checkRow().
      exports: [InvitationsService],
    };
  }
}
