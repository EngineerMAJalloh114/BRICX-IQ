// The global directory's one route (P6-01, ADR 0071; owner condition C5),
// under /v1/directory:
//   GET /resolve?org_slug=… | ?email_domain=… | ?cell=…   which cell
//       serves an organisation, or (P6-06, ADR 0077, D3) where the cell an
//       invitation token names is: 200 { cell, apiBaseUrl, keycloakUrl }
//       (nothing about any organisation), cached for a
//       day (an organisation's cell never changes); 404
//       directory.not_found, cached for 60 s, the same body for both keys.
// @Public(): the client asks before it knows its cell, so before it has a
// token. A slug's existence is discoverable by design; the mitigation is
// the edge WAF rate limit (a P13 Also line). An error other than 404
// carries no public cache header: the handler sets it once it has the
// answer (Nest's @Header() would also stamp a 422 or a 503).
import { Controller, Get, Inject, Query, Res } from "@nestjs/common";
import type { DirectoryReader } from "@bricx/db/directory";
import { ZodResponse } from "nestjs-zod";
import { RateLimit } from "../../common/rate-limit/rate-limit.decorator.js";
import { Public } from "../../common/auth/public.decorator.js";
import { ApiError } from "../../common/errors/api-error.js";
import { CellRoute, ResolveQuery } from "./directory.dto.js";
import { DIRECTORY_READER } from "./directory.tokens.js";

/** A cell route never changes, so a day is safe (for architect review). */
export const FOUND_CACHE_CONTROL = "public, max-age=86400";
/** An organisation may register a slug at any time: a short negative cache. */
export const NOT_FOUND_CACHE_CONTROL = "public, max-age=60";

interface Reply {
  header(name: string, value: string): unknown;
}

@Controller({ path: "directory", version: "1" })
@Public()
export class DirectoryController {
  constructor(
    @Inject(DIRECTORY_READER) private readonly reader: DirectoryReader,
  ) {}

  @Get("resolve")
  // P6-05d (ADR 0080, owner condition C2): sign-in routing survives a
  // Valkey outage, limited in-process at the auth_adjacent limits.
  @RateLimit("auth_adjacent", { storeDown: "fallback" })
  @ZodResponse({ status: 200, type: CellRoute })
  async resolve(
    @Query() query: ResolveQuery,
    @Res({ passthrough: true }) reply: Reply,
  ) {
    const route = await this.reader.resolve(
      query.cell !== undefined
        ? { cellId: query.cell }
        : query.org_slug === undefined
          ? { emailDomain: query.email_domain ?? "" }
          : { orgSlug: query.org_slug },
    );
    if (route === undefined) {
      reply.header("cache-control", NOT_FOUND_CACHE_CONTROL);
      throw new ApiError("directory.not_found");
    }
    reply.header("cache-control", FOUND_CACHE_CONTROL);
    return route;
  }
}
