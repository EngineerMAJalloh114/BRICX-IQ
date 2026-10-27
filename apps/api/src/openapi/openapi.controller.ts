// GET /openapi.json (P4-08, ADR 0058, decision 3a): the document as JSON
// text, version-neutral (not under /v1: it describes every version), with
// an ETag; no Swagger UI. The route is not in the document itself.
// P5-02 (plan decision D1, ADR 0062): OPENAPI_EXPOSURE picks the controller.
// public registers PublicOpenApiController (@Public()); authenticated
// registers OpenApiController, which the AuthGuard covers like any route;
// off registers neither (openapi.module.ts), so the path is 404.
import {
  Controller,
  Get,
  Header,
  Inject,
  Res,
  VERSION_NEUTRAL,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { NoPermission } from "../common/auth/can.decorator.js";
import { Public } from "../common/auth/public.decorator.js";
import { OpenApiDocumentHolder } from "./holder.js";

export const OPENAPI_PATH = "openapi.json";

interface Reply {
  header(name: string, value: string): unknown;
}

abstract class OpenApiRoute {
  constructor(
    @Inject(OpenApiDocumentHolder)
    private readonly holder: OpenApiDocumentHolder,
  ) {}

  @Get()
  @Header("content-type", "application/json; charset=utf-8")
  @Header("cache-control", "public, max-age=300")
  document(@Res({ passthrough: true }) reply: Reply): string {
    const { text, etag } = this.holder.get();
    reply.header("etag", etag);
    return text;
  }
}

/** OPENAPI_EXPOSURE=authenticated: a bearer token is required. */
@Controller({ path: OPENAPI_PATH, version: VERSION_NEUTRAL })
@ApiExcludeController()
@NoPermission("the API description, for any signed-in member")
export class OpenApiController extends OpenApiRoute {}

/** OPENAPI_EXPOSURE=public (refused in production by @bricx/config). */
@Controller({ path: OPENAPI_PATH, version: VERSION_NEUTRAL })
@ApiExcludeController()
@Public()
export class PublicOpenApiController extends OpenApiRoute {}
