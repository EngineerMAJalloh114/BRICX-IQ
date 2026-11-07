// The region configuration module (P6-03, ADR 0073): its controller and
// service. Audit comes through the audit module's public API (CLAUDE.md
// rule 13). The session idle timeout it stores is read by the auth
// module's DbOrgSessionPolicy (common/auth/session-policy.ts).
import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/public-api.js";
import { RegionConfigController } from "./region-config.controller.js";
import { RegionConfigService } from "./region-config.service.js";

@Module({
  imports: [AuditModule],
  controllers: [RegionConfigController],
  providers: [RegionConfigService],
})
export class RegionConfigModule {}
