// TemplateItems' policies (P4-09, ADR 0059): CASL checks from
// @bricx/permissions through the one checked entry point can(), over the
// ability abilityFor() builds from the request identity (P5 replaces it).
// A refused create is ApiError("forbidden") (403); RLS still isolates the
// org and the project underneath (CLAUDE.md rule 11).
import {
  type AccessFilter,
  type PermissionRecord,
  accessibleQuery,
  can,
} from "@bricx/permissions/ability";
import { abilityFor } from "../../common/auth/ability.js";
import type { Identity } from "../../common/db/request-context.js";
import { ApiError } from "../../common/errors/api-error.js";

/** The catalogue subject this module's rows are (@bricx/permissions). */
export const SUBJECT = "project.milestone";

/** Throws ApiError("forbidden") unless `identity` may create `record`. */
export function assertCanCreate(
  identity: Identity,
  record: PermissionRecord,
): void {
  if (!can(abilityFor(identity), "create", SUBJECT, record)) {
    throw new ApiError("forbidden");
  }
}

/** Whether `identity` may read `record`. */
export function canRead(identity: Identity, record: PermissionRecord): boolean {
  return can(abilityFor(identity), "read", SUBJECT, record);
}

/** The filters a listed row must match one of; [] when none may be read. */
export function readFilters(identity: Identity): readonly AccessFilter[] {
  const query = accessibleQuery(abilityFor(identity), "read", SUBJECT);
  return query.kind === "none" ? [] : query.filters;
}
