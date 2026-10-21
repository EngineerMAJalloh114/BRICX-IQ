// @Public() (P5-02, ADR 0062): the one way a route skips the global
// AuthGuard. Deny by default: a route without it needs a valid bearer
// token. Only the health routes and, when OPENAPI_EXPOSURE is public, the
// OpenAPI document carry it (test/auth-routes.test.ts pins the list). The
// marker is also an OpenAPI extension, so the document leaves the bearer
// security requirement off exactly these operations.
import { SetMetadata, applyDecorators } from "@nestjs/common";
import { ApiExtension } from "@nestjs/swagger";

/** The metadata key AuthGuard reads (handler first, then class). */
export const IS_PUBLIC = "bricx:public";
/** The OpenAPI extension on a public operation. */
export const PUBLIC_EXTENSION = "x-bricx-public";

export const Public = () =>
  applyDecorators(
    SetMetadata(IS_PUBLIC, true),
    ApiExtension(PUBLIC_EXTENSION, true),
  );
