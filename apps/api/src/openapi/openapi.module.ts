// Serves the document (P4-08, ADR 0058). The holder is filled by
// createApp() once the routes and versioning are configured; it exists in
// every mode, so building the document never depends on the route.
// P5-02 (ADR 0062): OPENAPI_EXPOSURE decides which controller, if any, is
// registered (openapi.controller.ts).
import type { OpenApiExposure } from "@bricx/config/api";
import { type DynamicModule, Module, type Type } from "@nestjs/common";
import { OpenApiDocumentHolder } from "./holder.js";
import {
  OpenApiController,
  PublicOpenApiController,
} from "./openapi.controller.js";

const CONTROLLERS: Readonly<Record<OpenApiExposure, readonly Type[]>> = {
  public: [PublicOpenApiController],
  authenticated: [OpenApiController],
  off: [],
};

@Module({})
export class OpenApiModule {
  static forRoot(exposure: OpenApiExposure): DynamicModule {
    return {
      module: OpenApiModule,
      controllers: [...CONTROLLERS[exposure]],
      providers: [OpenApiDocumentHolder],
      exports: [OpenApiDocumentHolder],
    };
  }
}
