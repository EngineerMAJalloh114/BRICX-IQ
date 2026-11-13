// Bulk invitations' boundary schemas (P6-06c, ADR 0085; owner condition
// C5, answer Q5): the request is bounded here (1 to MAX_BATCH_ROWS rows,
// no other field: 422); each row is parsed by the service with the single
// invite's own schema (CreateInvitation), so a malformed row is a failed
// row (validation_failed), never a refused batch. No response carries an
// address or a token: a row answers its number, status, error code and
// invitation id. Instants are ISO 8601 UTC with milliseconds.
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

/** Rows one batch may carry (Q5). */
export const MAX_BATCH_ROWS = 200;
/** Rows one org may submit per 24 h, refused rows included (Q5, K4). */
export const MAX_ROWS_PER_DAY = 1_000;
/** The quota's window. */
export const QUOTA_WINDOW_MS = 86_400_000;
/** Most rows one read returns. */
export const BATCH_ROW_LIST_LIMIT = 100;

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

const IdSchema = z
  .string({ error: typeError })
  .max(36, { error: "validation:invalid_value" })
  .regex(UUID_V7, { error: "validation:invalid_value" });

export class SubmitBatch extends createZodDto(
  strict({
    /** Each entry is a single invite's body, checked row by row. */
    rows: z
      .array(z.unknown(), { error: typeError })
      .min(1, { error: "validation:invalid_value" })
      .max(MAX_BATCH_ROWS, { error: "validation:too_large" }),
  }),
) {}
export type SubmitBatchInput = z.output<typeof SubmitBatch.schema>;

export class BatchParams extends createZodDto(strict({ id: IdSchema })) {}

/** A cursor this module wrote: the last row's number, base64url. */
export const encodeRowCursor = (rowNo: number): string =>
  Buffer.from(String(rowNo), "utf8").toString("base64url");

/** The row number inside a cursor this module wrote, or undefined. */
export function decodeRowCursor(cursor: string): number | undefined {
  if (cursor.length > 16 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return undefined;
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^\d{1,3}$/.test(text)) return undefined;
  const n = Number(text);
  return n >= 1 && n <= MAX_BATCH_ROWS ? n : undefined;
}

export class BatchRowsQuery extends createZodDto(
  strict({
    cursor: z
      .string({ error: typeError })
      .max(16, { error: "validation:invalid_value" })
      .refine((c) => decodeRowCursor(c) !== undefined, {
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
          .max(BATCH_ROW_LIST_LIMIT, { error: "validation:invalid_value" }),
      )
      .optional(),
  }),
) {}
export type BatchRowsInput = z.output<typeof BatchRowsQuery.schema>;

export const BATCH_STATUSES = ["queued", "running", "done"] as const;
export const BATCH_ROW_STATUSES = ["pending", "created", "failed"] as const;
export const BATCH_ROW_ERRORS = [
  "validation_failed",
  "not_found",
  "conflict",
  "escalation",
  "owner_role",
  "project_archived",
  "pending_exists",
  "inviter_inactive",
  "org_archived",
  "not_processed",
] as const;

/** The submit's answer (202): counts only. */
export class BatchAccepted extends createZodDto(
  strict({
    batchId: IdSchema,
    /** Rows stored pending: the worker turns each into an invitation. */
    accepted: z.number().int(),
    /** Rows refused at submission, each stored failed with its code. */
    failed: z.number().int(),
  }),
) {}
export type BatchAcceptedData = z.output<typeof BatchAccepted.schema>;

const InvitationBatchSchema = strict({
  id: IdSchema,
  status: z.enum(BATCH_STATUSES),
  createdBy: IdSchema,
  rowCount: z.number().int(),
  createdCount: z.number().int(),
  failedCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type InvitationBatchData = z.output<typeof InvitationBatchSchema>;

export class InvitationBatch extends createZodDto(InvitationBatchSchema) {}

const BatchRowSchema = strict({
  rowNo: z.number().int(),
  status: z.enum(BATCH_ROW_STATUSES),
  errorCode: z.enum(BATCH_ROW_ERRORS).nullable(),
  invitationId: IdSchema.nullable(),
});
export type BatchRowData = z.output<typeof BatchRowSchema>;

/** By row number, at most `limit`; nextCursor null on the last page. */
export class InvitationBatchRowList extends createZodDto(
  strict({
    items: z.array(BatchRowSchema),
    nextCursor: z.string().nullable(),
  }),
) {}
