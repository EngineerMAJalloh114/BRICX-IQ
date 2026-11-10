// Invitations' boundary schemas (P6-06, ADR 0077): nestjs-zod DTOs the
// global ZodValidationPipe parses requests with (422 validation_failed)
// and @ZodResponse serializes responses with. Ids are UUIDv7. The e-mail
// address is bounded, then normalised (NFKC, trimmed, lower-cased,
// @bricx/validation/email) before anything else sees it. A token is
// bounded (INVITATION_TOKEN_MAX) and travels only in a POST body (D2);
// its shape is the service's check, so a malformed token gets the same
// answer as an unknown one (D8). Instants are ISO 8601 UTC with
// milliseconds. No response carries the address once accepted, a token
// or its hash. Messages are issue codes.
import { INVITATION_TOKEN_MAX } from "@bricx/db/invitations";
import { normaliseEmail } from "@bricx/validation/email";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

/** Most invitations a list returns. */
export const INVITATION_LIST_LIMIT = 100;
/** Characters an address may have before normalisation (RFC 5321 path). */
export const EMAIL_INPUT_MAX = 320;

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const typeError = (issue: { readonly input?: unknown }) =>
  issue.input === undefined
    ? "validation:required"
    : "validation:invalid_value";

const objectError = (issue: {
  readonly code?: string;
  readonly input?: unknown;
}) =>
  issue.code === "unrecognized_keys"
    ? "validation:unknown_field"
    : typeError(issue);

const strict = <T extends z.core.$ZodLooseShape>(shape: T) =>
  z.strictObject(shape, { error: objectError });

export const IdSchema = z
  .string({ error: typeError })
  .max(36, { error: "validation:invalid_value" })
  .regex(UUID_V7, { error: "validation:invalid_value" });

const EmailInputSchema = z
  .string({ error: typeError })
  .max(EMAIL_INPUT_MAX, { error: "validation:too_large" })
  .transform((raw, ctx) => {
    const email = normaliseEmail(raw);
    if (email === undefined) {
      ctx.issues.push({
        code: "custom",
        message: "validation:invalid_value",
        input: raw,
      });
      return z.NEVER;
    }
    return String(email);
  });

export const INVITATION_STATUSES = [
  "pending",
  "accepted",
  "expired",
  "revoked",
] as const;

export class CreateInvitation extends createZodDto(
  strict({
    email: EmailInputSchema,
    /** The org role the invitee gets; required (no default role, D13). */
    roleId: IdSchema,
    /** A project invitation names the project and its project role. */
    projectId: IdSchema.optional(),
    projectRoleId: IdSchema.optional(),
  }).check((ctx) => {
    const project = ctx.value.projectId !== undefined;
    const projectRole = ctx.value.projectRoleId !== undefined;
    if (project !== projectRole) {
      ctx.issues.push({
        code: "custom",
        message: "validation:required",
        input: undefined,
        path: [project ? "projectRoleId" : "projectId"],
      });
    }
  }),
) {}
export type CreateInvitationInput = z.output<typeof CreateInvitation.schema>;

export class InvitationParams extends createZodDto(strict({ id: IdSchema })) {}

/** A cursor this module wrote: the last item's id, base64url. */
export const encodeCursor = (id: string): string =>
  Buffer.from(id, "utf8").toString("base64url");

/** The id inside a cursor this module wrote, or undefined. */
export function decodeCursor(cursor: string): string | undefined {
  if (cursor.length > 64 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return undefined;
  const id = Buffer.from(cursor, "base64url").toString("utf8");
  return UUID_V7.test(id) ? id : undefined;
}

export class ListInvitationsQuery extends createZodDto(
  strict({
    status: z
      .enum(INVITATION_STATUSES, { error: "validation:invalid_value" })
      .optional(),
    projectId: IdSchema.optional(),
    cursor: z
      .string({ error: typeError })
      .max(64, { error: "validation:invalid_value" })
      .refine((c) => decodeCursor(c) !== undefined, {
        error: "validation:invalid_cursor",
      })
      .optional(),
    limit: z
      .string({ error: typeError })
      .regex(/^\d{1,3}$/, { error: "validation:invalid_value" })
      .transform(Number)
      .pipe(
        z
          .number()
          .int()
          .min(1, { error: "validation:invalid_value" })
          .max(INVITATION_LIST_LIMIT, { error: "validation:invalid_value" }),
      )
      .optional(),
  }),
) {}
export type ListInvitationsInput = z.output<typeof ListInvitationsQuery.schema>;

/** The token, bounded; its shape is checked by the service (uniform answer). */
export class InvitationToken extends createZodDto(
  strict({
    token: z
      .string({ error: typeError })
      .min(1, { error: "validation:invalid_value" })
      .max(INVITATION_TOKEN_MAX, { error: "validation:invalid_value" }),
  }),
) {}

const InvitationSchema = strict({
  id: IdSchema,
  orgId: IdSchema,
  projectId: IdSchema.nullable(),
  /** The invited address; null once accepted (the accepter is acceptedBy). */
  email: z.string().nullable(),
  roleId: IdSchema,
  projectRoleId: IdSchema.nullable(),
  /** As presented: a pending row past expiresAt is expired (lazy expiry, D10). */
  status: z.enum(INVITATION_STATUSES),
  expiresAt: z.string(),
  resendCount: z.number().int(),
  lastSentAt: z.string().nullable(),
  invitedBy: IdSchema,
  acceptedBy: IdSchema.nullable(),
  acceptedAt: z.string().nullable(),
  revokedBy: IdSchema.nullable(),
  revokedAt: z.string().nullable(),
  revokeReason: z.string().nullable(),
  createdAt: z.string(),
});
export type InvitationData = z.output<typeof InvitationSchema>;

export class Invitation extends createZodDto(InvitationSchema) {}

/** Newest first, at most `limit`; nextCursor null on the last page. */
export class InvitationList extends createZodDto(
  strict({
    items: z.array(InvitationSchema),
    nextCursor: z.string().nullable(),
  }),
) {}

/** Activate's one answer, whatever the token (D6, D8). */
export class ActivationAccepted extends createZodDto(
  strict({ status: z.literal("accepted") }),
) {}

/** Accept's answer: the membership exists now (or already did). */
export class AcceptedInvitation extends createZodDto(
  strict({
    orgId: IdSchema,
    projectId: IdSchema.nullable(),
    outcome: z.enum(["joined", "already_member"]),
  }),
) {}
export type AcceptedInvitationData = z.output<typeof AcceptedInvitation.schema>;
