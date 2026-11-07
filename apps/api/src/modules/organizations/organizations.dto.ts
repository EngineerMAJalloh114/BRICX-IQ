// Organisations' boundary schemas (P6-02, ADR 0072): nestjs-zod DTOs the
// global ZodValidationPipe parses requests with (422 validation_failed)
// and @ZodResponse serializes responses with. The whole create body is
// checked here, before any transaction (owner condition C2), with
// @bricx/validation's schemas: ISO 3166-1 country, ISO 4217 currency, a
// supported language (en, fr, ar), an IANA time zone; the slug is
// @bricx/validation/reserved-slugs' pattern (the tables' CHECK); units is
// optional (the country's default, D8); the brand colour is #rrggbb in
// lower case (D7). The id, the data region and the times are never a
// field. Messages are issue codes.
import { CountryCodeSchema } from "@bricx/validation/country";
import { CurrencySchema } from "@bricx/validation/currency";
import { SupportedLocaleSchema } from "@bricx/validation/locale";
import { ORGANIZATION_SLUG_PATTERN } from "@bricx/validation/reserved-slugs";
import { TimeZoneSchema } from "@bricx/validation/time-zone";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

/** Most characters in a legal name (organizations_legal_name_length CHECK). */
export const LEGAL_NAME_MAX = 200;
/** The measurement systems (organizations_units CHECK, @bricx/domain). */
export const UNITS = ["metric", "us_customary"] as const;

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

const SlugSchema = z
  .string({ error: typeError })
  .max(63, { error: "validation:invalid_value" })
  .regex(ORGANIZATION_SLUG_PATTERN, { error: "validation:invalid_value" });

const LegalNameSchema = z
  .string({ error: typeError })
  .min(1, { error: "validation:required" })
  .max(LEGAL_NAME_MAX, { error: "validation:too_large" });

const UnitsSchema = z.enum(UNITS, { error: typeError });

const BrandColorSchema = z
  .string({ error: typeError })
  .max(7, { error: "validation:invalid_value" })
  .regex(/^#[0-9a-f]{6}$/, { error: "validation:invalid_value" });

/** The codes as plain strings (the wire carries no brand). */
const Country = CountryCodeSchema.transform((c): string => c);
const Currency = CurrencySchema.transform((c): string => String(c));
const Language = SupportedLocaleSchema.transform((l): string => l);
const TimeZone = TimeZoneSchema.transform((t): string => t);

export const CreateOrganizationSchema = strict({
  slug: SlugSchema,
  legalName: LegalNameSchema,
  country: Country,
  defaultCurrency: Currency,
  defaultLanguage: Language,
  timezone: TimeZone,
  units: UnitsSchema.optional(),
  brandColor: BrandColorSchema.optional(),
});
export type CreateOrganizationInput = z.output<typeof CreateOrganizationSchema>;

export class CreateOrganization extends createZodDto(
  CreateOrganizationSchema,
) {}

/** At least one field; the slug, the region and the id are not fields (D5). */
export const UpdateOrganizationSchema = strict({
  legalName: LegalNameSchema.optional(),
  country: Country.optional(),
  defaultCurrency: Currency.optional(),
  defaultLanguage: Language.optional(),
  timezone: TimeZone.optional(),
  units: UnitsSchema.optional(),
  brandColor: BrandColorSchema.nullable().optional(),
}).refine((body) => Object.keys(body).length > 0, {
  error: "validation:required",
});
export type UpdateOrganizationInput = z.output<typeof UpdateOrganizationSchema>;

export class UpdateOrganization extends createZodDto(
  UpdateOrganizationSchema,
) {}

const OrganizationSchema = strict({
  id: z.string(),
  slug: z.string(),
  legalName: z.string(),
  country: z.string(),
  defaultCurrency: z.string(),
  defaultLanguage: z.string(),
  timezone: z.string(),
  units: z.enum(UNITS),
  /** The cell that holds the organisation (CELL_ID at creation). */
  dataRegion: z.string(),
  brandColor: z.string().nullable(),
  logoObjectKey: z.string().nullable(),
  /** UTC, ISO 8601 with microseconds. */
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});
export type OrganizationData = z.output<typeof OrganizationSchema>;

export class Organization extends createZodDto(OrganizationSchema) {}
