// The access-grants module (P5-06, ADR 0067): its controllers, service
// and repository, plus the per-user cap and the longest window from
// config (D-C). Memberships (their repository, for the membership
// checks), audit and outbox come through their modules' public APIs
// (CLAUDE.md rule 13); TxRunner, CLOCK and the logger are global.
import { type DynamicModule, Module } from "@nestjs/common";
import { AuditModule } from "../audit/public-api.js";
import { MembershipsModule } from "../memberships/public-api.js";
import { OutboxModule } from "../outbox/public-api.js";
import {
  AccessGrantsController,
  MyAccessGrantsController,
} from "./access-grants.controller.js";
import { AccessGrantsRepository } from "./access-grants.repository.js";
import {
  ACCESS_GRANT_MAX_SECONDS,
  ACCESS_GRANTS_MAX_PER_USER,
  AccessGrantsService,
} from "./access-grants.service.js";

export interface AccessGrantsModuleOptions {
  /** `accessGrants.maxPerUser` from the API config (ACCESS_GRANTS_MAX_PER_USER). */
  readonly maxPerUser: number;
  /** `accessGrants.maxSeconds` from the API config (ACCESS_GRANT_MAX_SECONDS). */
  readonly maxSeconds: number;
}

@Module({})
export class AccessGrantsModule {
  static forRoot(options: AccessGrantsModuleOptions): DynamicModule {
    return {
      module: AccessGrantsModule,
      imports: [AuditModule, OutboxModule, MembershipsModule],
      controllers: [AccessGrantsController, MyAccessGrantsController],
      providers: [
        AccessGrantsService,
        AccessGrantsRepository,
        { provide: ACCESS_GRANTS_MAX_PER_USER, useValue: options.maxPerUser },
        { provide: ACCESS_GRANT_MAX_SECONDS, useValue: options.maxSeconds },
      ],
    };
  }
}
