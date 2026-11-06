// @AllowArchivedOrg() (P6-02, ADR 0072; task decisions D6 and D16): an
// archived organisation answers 404 not_found on every route (the
// AuthGuard reads the grants source's orgArchived after the membership
// check, before any revocation check or session row), except a route
// marked with this: GET /v1/organizations/current, so its members can
// still see that it is archived. Handler-level only, and an OpenAPI
// extension, so the set of such operations can be pinned.
import { SetMetadata, applyDecorators } from "@nestjs/common";
import { ApiExtension } from "@nestjs/swagger";

/** The metadata key the AuthGuard reads (the handler only). */
export const ALLOW_ARCHIVED_ORG = "bricx:allow-archived-org";
/** The OpenAPI extension on such an operation. */
export const ALLOW_ARCHIVED_ORG_EXTENSION = "x-bricx-allow-archived-org";

export const AllowArchivedOrg = () =>
  applyDecorators(
    SetMetadata(ALLOW_ARCHIVED_ORG, true),
    ApiExtension(ALLOW_ARCHIVED_ORG_EXTENSION, true),
  );
