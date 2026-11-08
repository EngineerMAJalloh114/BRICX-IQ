// Projects' boundary schemas (P6-05, ADR 0075 D16, D18; owner conditions
// C1, C3, C5, C7, C8): nestjs-zod DTOs the global ZodValidationPipe parses
// requests with (422 validation_failed) and @ZodResponse serializes
// responses with. Messages are issue codes, never input.
// - code: ^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$ (C7); unique per org
//   regardless of case is the table's (409).
// - name 1..200, clientName 1..200 or null; dates are calendar dates
//   (YYYY-MM-DD), start <= end is the service's (422 at endDate).
// - currency and reportingCurrency are ISO 4217 codes, timezone a tzdb
//   zone; omitted on create, they default from the organisation's
//   effective configuration (the service).
// - contractValue is MoneySchema (minor units as a string, a currency with
//   a minor unit, signed 64-bit) and never negative (C8); null clears it.
// - A PATCH with no field is 422; the status route takes { to }.
// - Lists: keyset by id (UUIDv7), newest first; limit 1..100, default 25;
//   ?status= one of the five statuses (C5).
import {
  type ProjectStatus,
  PROJECT_STATUSES,
} from "@bricx/domain/project-status";
import { MoneyJsonSchema, MoneySchema } from "@bricx/validation/money";
import { CurrencySchema } from "@bricx/validation/currency";
import {
  CursorSchema,
  PageLimitSchema,
  pageOf,
} from "@bricx/validation/pagination";
import { TimeZoneSchema } from "@bricx/validation/time-zone";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

/** The code pattern (C7; the table's CHECK says the same). */
export const PROJECT_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
/** Most characters in a name or client name (the table's CHECKs say the same). */
export const PROJECT_NAME_MAX = 200;

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const typeError = (issue: { readonly input?: unknown }) =>
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

export const strict = <T extends z.core.$ZodLooseShape>(shape: T) =>
  z.strictObject(shape, { error: objectError });

export const IdSchema = z
  .string({ error: typeError })
  .max(36, { error: "validation:invalid_value" })
  .regex(UUID_V7, { error: "validation:invalid_value" });

const CodeSchema = z
  .string({ error: typeError })
  .max(32, { error: "validation:invalid_value" })
  .regex(PROJECT_CODE, { error: "validation:invalid_value" });

export const textOf = (max: number) =>
  z
    .string({ error: typeError })
    .min(1, { error: "validation:invalid_value" })
    .max(max, { error: "validation:invalid_value" });

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const leap = (year: number) =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** Whether YYYY-MM-DD names a real calendar day (no Date involved). */
function isCalendarDate(value: string): boolean {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  const max = month === 2 && leap(year) ? 29 : (DAYS[month - 1] ?? 0);
  return day <= max;
}

const DateSchema = z
  .string({ error: typeError })
  .max(10, { error: "validation:invalid_value" })
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: "validation:invalid_value" })
  .refine(isCalendarDate, { error: "validation:invalid_value" });

/** The codes as plain strings (the wire carries no brand). */
const Currency = CurrencySchema.transform((c): string => String(c));
const TimeZone = TimeZoneSchema.transform((t): string => t);

/** A contract value: MoneySchema, never negative (C8). */
const ContractValue = MoneySchema.refine((money) => money.amount >= 0n, {
  error: "validation:invalid_value",
});

const StatusSchema = z.enum(PROJECT_STATUSES, { error: typeError });

const FIELDS = {
  name: textOf(PROJECT_NAME_MAX),
  clientName: textOf(PROJECT_NAME_MAX).nullable().optional(),
  currency: Currency.optional(),
  reportingCurrency: Currency.optional(),
  timezone: TimeZone.optional(),
  startDate: DateSchema.nullable().optional(),
  endDate: DateSchema.nullable().optional(),
  contractValue: ContractValue.nullable().optional(),
};

export const CreateProjectSchema = strict({ code: CodeSchema, ...FIELDS });
export type CreateProjectInput = z.output<typeof CreateProjectSchema>;
export class CreateProject extends createZodDto(CreateProjectSchema) {}

export const UpdateProjectSchema = strict({
  code: CodeSchema.optional(),
  ...FIELDS,
  name: FIELDS.name.optional(),
}).refine((body) => Object.keys(body).length > 0, {
  error: "validation:required",
});
export type UpdateProjectInput = z.output<typeof UpdateProjectSchema>;
export class UpdateProject extends createZodDto(UpdateProjectSchema) {}

export class ProjectParams extends createZodDto(strict({ id: IdSchema })) {}

export const MoveProjectSchema = strict({ to: StatusSchema });
export class MoveProject extends createZodDto(MoveProjectSchema) {}

/** The cursor this module writes: the last item's id, base64url. */
export const encodeCursor = (id: string): string =>
  Buffer.from(id, "utf8").toString("base64url");

/** The id inside a cursor this module wrote, or undefined. */
export function decodeCursor(cursor: string): string | undefined {
  const id = Buffer.from(cursor, "base64url").toString("utf8");
  return UUID_V7.test(id) ? id : undefined;
}

export const PageCursor = CursorSchema.refine(
  (c) => decodeCursor(c) !== undefined,
  { error: "validation:invalid_cursor" },
);

export const ListProjectsQuerySchema = strict({
  cursor: PageCursor.optional(),
  limit: PageLimitSchema,
  status: StatusSchema.optional(),
});
export type ListProjectsInput = z.output<typeof ListProjectsQuerySchema>;
export class ListProjectsQuery extends createZodDto(ListProjectsQuerySchema) {}

const ProjectSchema = strict({
  id: IdSchema,
  code: z.string(),
  name: z.string(),
  clientName: z.string().nullable(),
  status: StatusSchema,
  currency: z.string(),
  reportingCurrency: z.string(),
  timezone: z.string(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  /** Only for callers holding project.project.update on it; else null (C8). */
  contractValue: MoneyJsonSchema.nullable(),
  createdBy: IdSchema,
  /** UTC, ISO 8601 with microseconds. */
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});
export type ProjectData = z.output<typeof ProjectSchema> & {
  readonly status: ProjectStatus;
};
export class Project extends createZodDto(ProjectSchema) {}

/** A page of projects, newest first. */
export class ProjectPage extends createZodDto(pageOf(ProjectSchema)) {}
