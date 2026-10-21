// The devices module (P5-03, ADR 0063): its controller, service and
// repository, plus the per-user cap from config (owner review fix 2).
// Sessions (binding and revoking) come through the sessions module's
// public API, audit through its own (CLAUDE.md rule 13).
import { type DynamicModule, Module } from "@nestjs/common";
import { AuditModule } from "../audit/public-api.js";
import { SessionsModule } from "../sessions/public-api.js";
import { DevicesController } from "./devices.controller.js";
import { DevicesRepository } from "./devices.repository.js";
import { DEVICES_MAX_PER_USER, DevicesService } from "./devices.service.js";

export interface DevicesModuleOptions {
  /** `devices.maxPerUser` from the API config (DEVICES_MAX_PER_USER). */
  readonly maxPerUser: number;
}

@Module({})
export class DevicesModule {
  static forRoot(options: DevicesModuleOptions): DynamicModule {
    return {
      module: DevicesModule,
      imports: [AuditModule, SessionsModule],
      controllers: [DevicesController],
      providers: [
        DevicesService,
        DevicesRepository,
        { provide: DEVICES_MAX_PER_USER, useValue: options.maxPerUser },
      ],
    };
  }
}
