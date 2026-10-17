// TemplateItems' boundary schemas (P4-09, ADR 0059): nestjs-zod DTOs the
// global ZodValidationPipe parses requests with (422 validation_failed,
// ADR 0047's envelope) and @ZodResponse serializes responses with. Ids are
// lower-case UUIDv7 (made on the device, CLAUDE.md rule 6); the org and
// the creator never come from the body. Error messages are issue codes
// ("validation:<code>"), never text.
import {
  CursorSchema,
  PageLimitSchema,
  pageOf,
} from "@bricx/validation/pagination";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

/** Most characters in a name (the table's CHECK says the same). */
export const NAME_MAX = 200;

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A missing value is required; a value of the wrong type invalid_value. */
const typeError = (issue: { readonly input?: unknown }) =>
  issue.input === undefined
    ? "validation:required"
    : "validation:invalid_value";

const IdSchema = z
  .string({ error: typeError })
  .max(36, { error: "validation:invalid_value" })
  .regex(UUID_V7, { error: "validation:invalid_value" });

const NameSchema = z
  .string({ error: typeError })
  .min(1, { error: "validation:required" })
  .max(NAME_MAX, { error: "validation:too_large" });

/** Unknown keys are unknown_field; a missing one is required. */
const objectError = (issue: {
  readonly code?: string;
  readonly input?: unknown;
}) =>
  issue.code === "unrecognized_keys"
    ? "validation:unknown_field"
    : typeError(issue);

const strict = <T extends z.core.$ZodLooseShape>(shape: T) =>
  z.strictObject(shape, { error: objectError });

export class CreateTemplateItem extends createZodDto(
  strict({ id: IdSchema, projectId: IdSchema, name: NameSchema }),
) {}

export class TemplateItemParams extends createZodDto(
  strict({ id: IdSchema }),
) {}

const TemplateItemSchema = strict({
  id: IdSchema,
  projectId: IdSchema,
  name: NameSchema,
  createdBy: IdSchema,
  /** UTC, ISO 8601 with microseconds (2026-10-17T21:00:00.000000Z). */
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.int().min(1),
});
export type TemplateItemData = z.output<typeof TemplateItemSchema>;

export class TemplateItem extends createZodDto(TemplateItemSchema) {}

export class TemplateItemPage extends createZodDto(
  pageOf(TemplateItemSchema),
) {}

/** The cursor this module writes: the last item's id, base64url. */
export const encodeCursor = (id: string): string =>
  Buffer.from(id, "utf8").toString("base64url");

/** The id inside a cursor this module wrote, or undefined. */
export function decodeCursor(cursor: string): string | undefined {
  const id = Buffer.from(cursor, "base64url").toString("utf8");
  return UUID_V7.test(id) ? id : undefined;
}

export class ListTemplateItemsQuery extends createZodDto(
  strict({
    projectId: IdSchema,
    cursor: CursorSchema.refine((c) => decodeCursor(c) !== undefined, {
      error: "validation:invalid_cursor",
    }).optional(),
    limit: PageLimitSchema,
  }),
) {}
