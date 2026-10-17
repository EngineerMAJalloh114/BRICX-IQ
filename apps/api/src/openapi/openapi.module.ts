// Serves the document (P4-08, ADR 0058). The holder is filled by
// createApp() once the routes and versioning are configured.
import { Module } from "@nestjs/common";
import { OpenApiDocumentHolder } from "./holder.js";
import { OpenApiController } from "./openapi.controller.js";

@Module({
  controllers: [OpenApiController],
  providers: [OpenApiDocumentHolder],
  exports: [OpenApiDocumentHolder],
})
export class OpenApiModule {}
