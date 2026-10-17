// The TemplateItems module (P4-09, ADR 0059): its controller, service and
// repository. Audit and outbox come through their modules' public APIs
// (CLAUDE.md rule 13); TxRunner is global (DatabaseModule).
// new-module:template-only:start
// The template itself is never registered in AppModule: pnpm new-module
// copies it, and the copy is registered at the marker in app.module.ts.
// new-module:template-only:end
import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/public-api.js";
import { OutboxModule } from "../outbox/public-api.js";
import { TemplateItemsController } from "./template-items.controller.js";
import { TemplateItemsRepository } from "./template-items.repository.js";
import { TemplateItemsService } from "./template-items.service.js";

@Module({
  imports: [AuditModule, OutboxModule],
  controllers: [TemplateItemsController],
  providers: [TemplateItemsService, TemplateItemsRepository],
})
export class TemplateItemsModule {}
