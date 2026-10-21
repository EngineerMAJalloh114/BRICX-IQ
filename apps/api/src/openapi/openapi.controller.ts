// GET /openapi.json (P4-08, ADR 0058, decision 3a): the document as JSON
// text, version-neutral (not under /v1: it describes every version), with
// an ETag; no Swagger UI. The route is not in the document itself.
// Public (P5-02): commit 6 makes this follow OPENAPI_EXPOSURE.
import {
  Controller,
  Get,
  Header,
  Inject,
  Res,
  VERSION_NEUTRAL,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { Public } from "../common/auth/public.decorator.js";
import { OpenApiDocumentHolder } from "./holder.js";

export const OPENAPI_PATH = "openapi.json";

interface Reply {
  header(name: string, value: string): unknown;
}

@Controller({ path: OPENAPI_PATH, version: VERSION_NEUTRAL })
@ApiExcludeController()
@Public()
export class OpenApiController {
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
