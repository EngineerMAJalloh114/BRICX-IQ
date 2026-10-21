// The devices module (P5-03, ADR 0063): its controller, service and
// repository. Sessions (binding and revoking) come through the sessions
// module's public API, audit through its own (CLAUDE.md rule 13).
import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/public-api.js";
import { SessionsModule } from "../sessions/public-api.js";
import { DevicesController } from "./devices.controller.js";
import { DevicesRepository } from "./devices.repository.js";
import { DevicesService } from "./devices.service.js";

@Module({
  imports: [AuditModule, SessionsModule],
  controllers: [DevicesController],
  providers: [DevicesService, DevicesRepository],
})
export class DevicesModule {}
