// Access grants' boundary schemas (P5-06, ADR 0067): nestjs-zod DTOs the
// global ZodValidationPipe parses requests with (422 validation_failed)
// and @ZodResponse serializes responses with. Ids are UUIDv7; the
// permission is a catalogue key (its scope rule, the window and the
// self-grant rule are the service's, 422 with the field's path); the
// reason is 1..500 characters (the table's CHECK says the same) and is
// returned and audited, never logged. Instants are ISO 8601 UTC with
// milliseconds. Messages are issue codes.
import { parseCatalogueKey } from "@bricx/permissions/catalogue";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

/** Most characters in a reason (the table's CHECK says the same). */
export const REASON_MAX = 500;
/** Most grants a list returns. */
export const GRANT_LIST_LIMIT = 100;
/** The shortest elevation window, in seconds (the table's CHECK says the same). */
export const MIN_SECONDS = 60;
/** How far ahead an elevation may start, in seconds (30 days). */
export const MAX_START_AHEAD_SECONDS = 30 * 86_400;

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

/** An instant: ISO 8601, UTC (Z), seconds with an optional fraction. */
const InstantSchema = z
  .string({ error: typeError })
  .max(30, { error: "validation:invalid_value" })
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/, {
    error: "validation:invalid_value",
  })
  .refine((value) => Number.isFinite(Date.parse(value)), {
    error: "validation:invalid_value",
  });

/** A catalogue key (its scope rule is the service's). */
const PermissionSchema = z
  .string({ error: typeError })
  .max(72, { error: "validation:invalid_value" })
  .refine((key) => parseCatalogueKey(key) !== undefined, {
    error: "validation:invalid_value",
  });

const ReasonSchema = z
  .string({ error: typeError })
  .min(1, { error: "validation:invalid_value" })
  .max(REASON_MAX, { error: "validation:invalid_value" });

export class CreateAccessGrant extends createZodDto(
  strict({
    userId: IdSchema,
    permission: PermissionSchema,
    scopeId: IdSchema.optional(),
    reason: ReasonSchema,
    /** Defaults to now. */
    startsAt: InstantSchema.optional(),
    expiresAt: InstantSchema,
  }),
) {}
export type CreateAccessGrantInput = z.output<typeof CreateAccessGrant.schema>;

export class AccessGrantParams extends createZodDto(strict({ id: IdSchema })) {}

export class ListAccessGrantsQuery extends createZodDto(
  strict({ userId: IdSchema.optional() }),
) {}

const AccessGrantSchema = strict({
  id: IdSchema,
  orgId: IdSchema,
  userId: IdSchema,
  /** The catalogue key. */
  permission: z.string(),
  /** The project of a project-scoped key; null for an org-scoped one. */
  scopeId: IdSchema.nullable(),
  reason: z.string(),
  grantedBy: IdSchema,
  startsAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  revokedBy: IdSchema.nullable(),
  /** Set by the worker when it recorded the expiry; the end is effective at expiresAt regardless. */
  expiredAt: z.string().nullable(),
  /** Whether the grant is in force now: started, not ended, not revoked. */
  active: z.boolean(),
  createdAt: z.string(),
});
export type AccessGrantData = z.output<typeof AccessGrantSchema>;

export class AccessGrant extends createZodDto(AccessGrantSchema) {}

/** Open grants, newest first, at most 100. */
export class AccessGrantList extends createZodDto(
  strict({ items: z.array(AccessGrantSchema) }),
) {}
