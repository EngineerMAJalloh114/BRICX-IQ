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

export class UpdateMember extends createZodDto(strict({ roleId: IdSchema })) {}

/** Most characters of a suspension reason (owner condition C8; the column's CHECK). */
export const MAX_SUSPEND_REASON = 200;
/** Most characters of a renewal reason (audited, never stored on the row). */
export const MAX_RENEW_REASON = 500;
/** The shortest and the longest temporary membership (owner answer Q6). */
export const MIN_MEMBERSHIP_MS = 3_600_000;
export const MAX_MEMBERSHIP_MS = 366 * 86_400_000;
/** The widest "expiring within" window of the member list, in days. */
export const MAX_EXPIRING_DAYS = 90;

/** UTC, ISO 8601, milliseconds, Z: the form toISOString() writes. */
export const InstantSchema = z
  .string({ error: typeError })
  .max(24, { error: "validation:invalid_value" })
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, {
    error: "validation:invalid_value",
  })
  .refine(
    (value) => {
      const ms = Date.parse(value);
      return Number.isFinite(ms) && new Date(ms).toISOString() === value;
    },
    { error: "validation:invalid_value" },
  );

const reason = (max: number) =>
  z
    .string({ error: typeError })
    .min(1, { error: "validation:required" })
    .max(max, { error: "validation:too_large" })
    .refine((value) => value.trim().length > 0, {
      error: "validation:required",
    });

/** A suspension: the reason is stored, returned to org.member.read holders, never logged. */
export class SuspendMember extends createZodDto(
  strict({ reason: reason(MAX_SUSPEND_REASON) }),
) {}

/** A renewal: a new end and why (audited). */
export class RenewMember extends createZodDto(
  strict({ expiresAt: InstantSchema, reason: reason(MAX_RENEW_REASON) }),
) {}

/** GET /v1/members?expiringWithinDays=N (1..90): the temporary members ending soon. */
export class MemberListQuery extends createZodDto(
  strict({
    expiringWithinDays: z
      .string({ error: typeError })
      .regex(/^[1-9]\d?$/, { error: "validation:invalid_value" })
      .transform(Number)
      .pipe(
        z
          .number()
          .int()
          .min(1, { error: "validation:invalid_value" })
          .max(MAX_EXPIRING_DAYS, { error: "validation:invalid_value" }),
      )
      .optional(),
  }),
) {}

/** active, or why not: suspended wins over expired. */
export const MemberStatusSchema = z.enum(["active", "suspended", "expired"]);
export type MemberStatus = z.output<typeof MemberStatusSchema>;

/** The lifecycle fields every member answer carries (P6-06b, ADR 0084). */
const lifecycle = {
  /** Judged at the request's Clock. */
  status: MemberStatusSchema,
  suspendedAt: z.string().nullable(),
  /** Only for a caller holding org.member.read; null otherwise (owner addition A3). */
  suspendReason: z.string().nullable(),
  /** A temporary membership's end; null is permanent. */
  expiresAt: z.string().nullable(),
  /** memberships.is_external of the member's org membership. */
  external: z.boolean(),
};

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
  ...lifecycle,
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
    /** A temporary project membership's end (P6-06b); absent: permanent. */
    expiresAt: InstantSchema.optional(),
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
  ...lifecycle,
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
  /** P6-06b (ADR 0084): never the suspension reason (owner addition A3). */
  status: MemberStatusSchema,
  expiresAt: z.string().nullable(),
  external: z.boolean(),
});
export type MyMembershipData = z.output<typeof MyMembershipSchema>;

/** The caller's open org memberships in every org (the own-row policies). */
export class MyMembershipList extends createZodDto(
  strict({ items: z.array(MyMembershipSchema) }),
) {}

/** GET /v1/members/:id/activity (P6-06b, ADR 0084): org.audit.read. */
export const ACTIVITY_DEFAULT_LIMIT = 50;
export const ACTIVITY_MAX_LIMIT = 100;

export class ActivityQuery extends createZodDto(
  strict({
    /** The seq of the last item of the previous page. */
    cursor: z
      .string({ error: typeError })
      .regex(/^[1-9]\d{0,17}$/, { error: "validation:invalid_value" })
      .optional(),
    limit: z
      .string({ error: typeError })
      .regex(/^[1-9]\d{0,2}$/, { error: "validation:invalid_value" })
      .transform(Number)
      .pipe(
        z.number().int().max(ACTIVITY_MAX_LIMIT, {
          error: "validation:invalid_value",
        }),
      )
      .optional(),
  }),
) {}

/**
 * One audit event of a member, as a fixed projection: never before/after,
 * the address, the device or the location (owner answer Q7).
 */
const ActivityItemSchema = strict({
  /** The event's position in the organisation's chain (a decimal string). */
  seq: z.string(),
  occurredAt: z.string(),
  action: z.string(),
  entityType: z.string(),
  entityId: IdSchema.nullable(),
  actorType: z.enum(["user", "system"]),
  /** Whether the member did it (true) or it was done to them (false). */
  byMember: z.boolean(),
  correlationId: z.string(),
});
export type ActivityItem = z.output<typeof ActivityItemSchema>;

export class MemberActivity extends createZodDto(
  strict({
    items: z.array(ActivityItemSchema),
    /** Pass as ?cursor= for the next page; null at the end. */
    nextCursor: z.string().nullable(),
  }),
) {}
