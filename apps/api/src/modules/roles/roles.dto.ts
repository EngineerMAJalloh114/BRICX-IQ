// Roles' boundary schemas (P5-05, ADR 0066): nestjs-zod DTOs the global
// ZodValidationPipe parses requests with (422 validation_failed) and
// @ZodResponse serializes responses with. A bundle is a list of catalogue
// keys (parseCatalogueKey), unique, at most the catalogue's size; the key
// and name bounds are the table's CHECKs. The id is made by the API.
// Messages are issue codes.
import { CATALOGUE, parseCatalogueKey } from "@bricx/permissions/catalogue";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

/** Most characters in a role key (roles_key CHECK). */
export const ROLE_KEY_MAX = 64;
/** Most characters in a role name (roles_name_length CHECK). */
export const ROLE_NAME_MAX = 100;
const ROLE_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const typeError = (issue: { readonly input?: unknown }) =>
  issue.input === undefined
    ? "validation:required"
    : "validation:invalid_value";

export const IdSchema = z
  .string({ error: typeError })
  .max(36, { error: "validation:invalid_value" })
  .regex(UUID_V7, { error: "validation:invalid_value" });

const KeySchema = z
  .string({ error: typeError })
  .min(1, { error: "validation:required" })
  .max(ROLE_KEY_MAX, { error: "validation:too_large" })
  .regex(ROLE_KEY, { error: "validation:invalid_value" });

const NameSchema = z
  .string({ error: typeError })
  .min(1, { error: "validation:required" })
  .max(ROLE_NAME_MAX, { error: "validation:too_large" });

/** A bundle: catalogue keys, unique, bounded by the catalogue's size. */
export const PermissionsSchema = z
  .array(
    z
      .string({ error: typeError })
      .max(72, { error: "validation:invalid_value" })
      .refine((key) => parseCatalogueKey(key) !== undefined, {
        error: "validation:invalid_value",
      }),
    { error: typeError },
  )
  .max(CATALOGUE.length, { error: "validation:too_large" })
  .refine((keys) => new Set(keys).size === keys.length, {
    error: "validation:invalid_value",
  });

const objectError = (issue: {
  readonly code?: string;
  readonly input?: unknown;
}) =>
  issue.code === "unrecognized_keys"
    ? "validation:unknown_field"
    : typeError(issue);

export const strict = <T extends z.core.$ZodLooseShape>(shape: T) =>
  z.strictObject(shape, { error: objectError });

export class CreateRole extends createZodDto(
  strict({ key: KeySchema, name: NameSchema, permissions: PermissionsSchema }),
) {}

/** A name, a bundle or both. */
export class UpdateRole extends createZodDto(
  strict({
    name: NameSchema.optional(),
    permissions: PermissionsSchema.optional(),
  }).refine(
    (body) => body.name !== undefined || body.permissions !== undefined,
    {
      error: "validation:required",
    },
  ),
) {}

export class RoleParams extends createZodDto(strict({ id: IdSchema })) {}

const RoleSchema = strict({
  id: IdSchema,
  key: KeySchema,
  name: NameSchema,
  /** The default bundle this row was copied from, or null for a custom role. */
  systemKey: z.string().nullable(),
  /** The open keys, sorted (the owner's from code). */
  permissions: z.array(z.string()),
  /** UTC, ISO 8601 with microseconds. */
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});
export type RoleData = z.output<typeof RoleSchema>;

export class Role extends createZodDto(RoleSchema) {}

/** The org's open roles, newest first, at most 100. */
export class RoleList extends createZodDto(
  strict({ items: z.array(RoleSchema) }),
) {}
