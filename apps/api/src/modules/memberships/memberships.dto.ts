// Memberships' boundary schemas (P5-05, ADR 0066): nestjs-zod DTOs the
// global ZodValidationPipe parses requests with (422 validation_failed)
// and @ZodResponse serializes responses with. Ids are UUIDv7 (users,
// roles, memberships; a project id until P6-05 is any UUIDv7). Overrides
// are two lists of catalogue keys, unique, at most MAX_OVERRIDE_LIST each
// (@bricx/permissions' bound); their meaning against the role's bundle is
// checked by the service (validateOverrides, 422 with the list's path).
// Messages are issue codes. P6-05 (ADR 0075 D15, owner condition C4): a
// project membership's siteIds, at most MAX_SITE_IDS, unique (a duplicate
// is invalid_value), stored and answered sorted; each must be an open
// site of the project (the service, 422 unknown_site).
import { parseCatalogueKey } from "@bricx/permissions/catalogue";
import { MAX_OVERRIDE_KEYS } from "@bricx/permissions/overrides";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

/** Most keys in one override list (add or remove): @bricx/permissions' bound. */
export const MAX_OVERRIDE_LIST = MAX_OVERRIDE_KEYS;
/** Most assigned sites on one project membership (P6-05). */
export const MAX_SITE_IDS = 100;
/** Most memberships a list returns. */
export const MEMBER_LIST_LIMIT = 100;

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

const objectError = (issue: {
  readonly code?: string;
  readonly input?: unknown;
}) =>
  issue.code === "unrecognized_keys"
    ? "validation:unknown_field"
    : typeError(issue);

const strict = <T extends z.core.$ZodLooseShape>(shape: T) =>
  z.strictObject(shape, { error: objectError });

/** One override list: catalogue keys, unique, bounded. */
const KeyListSchema = z
  .array(
    z
      .string({ error: typeError })
      .max(72, { error: "validation:invalid_value" })
      .refine((key) => parseCatalogueKey(key) !== undefined, {
        error: "validation:invalid_value",
      }),
    { error: typeError },
  )
  .max(MAX_OVERRIDE_LIST, { error: "validation:too_large" })
  .refine((keys) => new Set(keys).size === keys.length, {
    error: "validation:invalid_value",
  });

export const OverridesSchema = strict({
  add: KeyListSchema.optional(),
  remove: KeyListSchema.optional(),
});
export type OverridesInput = z.output<typeof OverridesSchema>;

/** A membership's assigned sites (P6-05, C4): ids, unique, bounded. */
export const SiteIdsSchema = z
  .array(IdSchema, { error: typeError })
  .max(MAX_SITE_IDS, { error: "validation:too_large" })
  .refine((ids) => new Set(ids).size === ids.length, {
    error: "validation:invalid_value",
  });

export class CreateMember extends createZodDto(
  strict({ userId: IdSchema, roleId: IdSchema }),
) {}

export class UpdateMember extends createZodDto(strict({ roleId: IdSchema })) {}

export class MemberParams extends createZodDto(strict({ id: IdSchema })) {}

const MemberSchema = strict({
  id: IdSchema,
  userId: IdSchema,
  roleId: IdSchema,
  /** UTC, ISO 8601 with microseconds. */
  createdAt: z.string(),
  removedAt: z.string().nullable(),
  /** Whether the member's effective keys now require MFA (D5, condition 1). */
  mfaRequired: z.boolean(),
});
export type MemberData = z.output<typeof MemberSchema>;

export class Member extends createZodDto(MemberSchema) {}

/** The org's open memberships, newest first, at most 100. */
export class MemberList extends createZodDto(
  strict({ items: z.array(MemberSchema) }),
) {}

export class ProjectParams extends createZodDto(
  strict({ projectId: IdSchema }),
) {}

export class ProjectMemberParams extends createZodDto(
  strict({ projectId: IdSchema, id: IdSchema }),
) {}

export class AssignProjectMember extends createZodDto(
  strict({
    userId: IdSchema,
    roleId: IdSchema,
    overrides: OverridesSchema.optional(),
    /** Absent or empty: no site keys (C4). */
    siteIds: SiteIdsSchema.optional(),
  }),
) {}

/** A role, overrides, sites, or any of them. */
export class UpdateProjectMember extends createZodDto(
  strict({
    roleId: IdSchema.optional(),
    overrides: OverridesSchema.optional(),
    siteIds: SiteIdsSchema.optional(),
  }).refine(
    (body) =>
      body.roleId !== undefined ||
      body.overrides !== undefined ||
      body.siteIds !== undefined,
    { error: "validation:required" },
  ),
) {}

const StoredOverridesSchema = strict({
  add: z.array(z.string()),
  remove: z.array(z.string()),
});

const ProjectMemberSchema = strict({
  id: IdSchema,
  projectId: IdSchema,
  userId: IdSchema,
  roleId: IdSchema,
  /** Both lists, sorted (empty when none). */
  overrides: StoredOverridesSchema,
  /** The open assigned sites, sorted (P6-05, C4). */
  siteIds: z.array(IdSchema),
  createdAt: z.string(),
  removedAt: z.string().nullable(),
  mfaRequired: z.boolean(),
});
export type ProjectMemberData = z.output<typeof ProjectMemberSchema>;

export class ProjectMember extends createZodDto(ProjectMemberSchema) {}

/** The project's open memberships, newest first, at most 100. */
export class ProjectMemberList extends createZodDto(
  strict({ items: z.array(ProjectMemberSchema) }),
) {}

const MyMembershipSchema = strict({
  id: IdSchema,
  orgId: IdSchema,
  roleId: IdSchema,
  createdAt: z.string(),
  /** The caller's open project memberships in that org, sorted. */
  projectIds: z.array(IdSchema),
});
export type MyMembershipData = z.output<typeof MyMembershipSchema>;

/** The caller's open org memberships in every org (the own-row policies). */
export class MyMembershipList extends createZodDto(
  strict({ items: z.array(MyMembershipSchema) }),
) {}
