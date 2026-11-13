// Ownership transfers' boundary schemas (P6-06c, ADR 0085): nestjs-zod
// DTOs the global ZodValidationPipe parses requests with (422
// validation_failed) and @ZodResponse serializes responses with. Ids are
// UUIDv7. The typed organisation name is bounded here and compared by the
// service after trim and NFKC (owner condition C4, S15); it is never
// stored, logged or answered. Instants are ISO 8601 UTC with milliseconds.
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

/** Characters the typed organisation name may have before folding. */
export const ORGANISATION_NAME_INPUT_MAX = 400;

export const TRANSFER_STATUSES = [
  "pending",
  "accepted",
  "declined",
  "cancelled",
  "expired",
] as const;

export const CANCEL_REASONS = [
  "manual",
  "initiator_changed",
  "recipient_changed",
  "org_archived",
] as const;

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

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const IdSchema = z
  .string({ error: typeError })
  .max(36, { error: "validation:invalid_value" })
  .regex(UUID_V7, { error: "validation:invalid_value" });

const OrganisationNameSchema = z
  .string({ error: typeError })
  .max(ORGANISATION_NAME_INPUT_MAX, { error: "validation:too_large" });

export class StartTransfer extends createZodDto(
  strict({
    /** The member who becomes the owner on acceptance. */
    toUserId: IdSchema,
    /** The role the outgoing owner keeps after acceptance (not the owner role). */
    previousOwnerRoleId: IdSchema,
    /** The organisation's legal name, typed (trim and NFKC apply). */
    organisationName: OrganisationNameSchema,
  }),
) {}
export type StartTransferInput = z.output<typeof StartTransfer.schema>;

export class TransferName extends createZodDto(
  strict({ organisationName: OrganisationNameSchema }),
) {}
export type TransferNameInput = z.output<typeof TransferName.schema>;

export class TransferParams extends createZodDto(strict({ id: IdSchema })) {}

const OwnershipTransferSchema = strict({
  id: IdSchema,
  status: z.enum(TRANSFER_STATUSES),
  initiatedBy: IdSchema,
  toUserId: IdSchema,
  previousOwnerRoleId: IdSchema,
  expiresAt: z.string(),
  createdAt: z.string(),
  settledAt: z.string().nullable(),
  settledBy: IdSchema.nullable(),
  cancelReason: z.enum(CANCEL_REASONS).nullable(),
});
export type OwnershipTransferData = z.output<typeof OwnershipTransferSchema>;

export class OwnershipTransfer extends createZodDto(OwnershipTransferSchema) {}
