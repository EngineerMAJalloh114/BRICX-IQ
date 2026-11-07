// Region configuration's boundary schemas (P6-03, ADR 0073): nestjs-zod
// DTOs the global ZodValidationPipe parses requests with (422
// validation_failed) and @ZodResponse serializes responses with.
// - The org row's PATCH has no currency, language, timezone or units (the
//   organisation's own columns, D8) and a project row's PATCH has no idle
//   timeout (D10): either sent is an unknown field, 422, before any
//   transaction (owner condition C3; the table's CHECKs are the backstop).
// - Every field is optional and nullable (null = inherit); a body with no
//   field is 422 (owner condition C1).
// - Codes: ISO 4217, a supported language, a tzdb zone, a well-formed BCP
//   47 format locale (canonicalised), adapter ids and opaque references by
//   @bricx/domain/region-config's patterns; at most 16 payment adapters, no
//   duplicates (stored sorted, D12); the idle timeout an integer of
//   SESSION_IDLE_SECONDS.min..max (C2). Messages are issue codes.
import { SESSION_IDLE_SECONDS } from "@bricx/domain/limits";
import {
  ADAPTER_ID_PATTERN,
  PAYMENT_ADAPTERS_MAX,
  REFERENCE_ID_PATTERN,
} from "@bricx/domain/region-config";
import { CurrencySchema } from "@bricx/validation/currency";
import {
  LanguageTagSchema,
  SupportedLocaleSchema,
} from "@bricx/validation/locale";
import { TimeZoneSchema } from "@bricx/validation/time-zone";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

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

/** The codes as plain strings (the wire carries no brand). */
const Currency = CurrencySchema.transform((c): string => String(c));
const Language = SupportedLocaleSchema.transform((l): string => l);
const FormatLocale = LanguageTagSchema.transform((l): string => l);
const TimeZone = TimeZoneSchema.transform((t): string => t);
const Units = z.enum(["metric", "us_customary"], { error: typeError });

const AdapterId = z
  .string({ error: typeError })
  .max(63, { error: "validation:invalid_value" })
  .regex(ADAPTER_ID_PATTERN, { error: "validation:invalid_value" });

const ReferenceId = z
  .string({ error: typeError })
  .max(64, { error: "validation:invalid_value" })
  .regex(REFERENCE_ID_PATTERN, { error: "validation:invalid_value" });

const PaymentAdapters = z
  .array(AdapterId, { error: typeError })
  .max(PAYMENT_ADAPTERS_MAX, { error: "validation:too_large" })
  .refine((list) => new Set(list).size === list.length, {
    error: "validation:invalid_value",
  })
  .transform((list) => [...list].sort());

const SessionIdleSeconds = z
  .number({ error: typeError })
  .int({ error: "validation:invalid_value" })
  .min(SESSION_IDLE_SECONDS.min, { error: "validation:invalid_value" })
  .max(SESSION_IDLE_SECONDS.max, { error: "validation:invalid_value" });

/** The fields both layers may set. */
const SHARED = {
  reportingCurrency: Currency.nullable().optional(),
  formatLocale: FormatLocale.nullable().optional(),
  taxProfileId: ReferenceId.nullable().optional(),
  paymentAdapters: PaymentAdapters.nullable().optional(),
  accountingAdapter: AdapterId.nullable().optional(),
  rateLibrary: ReferenceId.nullable().optional(),
};

const notEmpty = (body: object) => Object.keys(body).length > 0;

/** The org row: no organisation column (D8); the idle timeout (D6). */
export const UpdateOrgRegionConfigSchema = strict({
  ...SHARED,
  sessionIdleSeconds: SessionIdleSeconds.nullable().optional(),
}).refine(notEmpty, { error: "validation:required" });
export type UpdateOrgRegionConfigInput = z.output<
  typeof UpdateOrgRegionConfigSchema
>;
export class UpdateOrgRegionConfig extends createZodDto(
  UpdateOrgRegionConfigSchema,
) {}

/** A project row: every field but the idle timeout (D10). */
export const UpdateProjectRegionConfigSchema = strict({
  ...SHARED,
  currency: Currency.nullable().optional(),
  language: Language.nullable().optional(),
  timezone: TimeZone.nullable().optional(),
  units: Units.nullable().optional(),
}).refine(notEmpty, { error: "validation:required" });
export type UpdateProjectRegionConfigInput = z.output<
  typeof UpdateProjectRegionConfigSchema
>;
export class UpdateProjectRegionConfig extends createZodDto(
  UpdateProjectRegionConfigSchema,
) {}

export class ProjectRegionConfigParams extends createZodDto(
  strict({ projectId: IdSchema }),
) {}

export class EffectiveRegionConfigQuery extends createZodDto(
  strict({ projectId: IdSchema.optional() }),
) {}

const RegionConfigLayerSchema = strict({
  /** null for the org row. */
  projectId: z.string().nullable(),
  currency: z.string().nullable(),
  reportingCurrency: z.string().nullable(),
  language: z.string().nullable(),
  timezone: z.string().nullable(),
  formatLocale: z.string().nullable(),
  units: z.string().nullable(),
  taxProfileId: z.string().nullable(),
  paymentAdapters: z.array(z.string()).nullable(),
  accountingAdapter: z.string().nullable(),
  rateLibrary: z.string().nullable(),
  sessionIdleSeconds: z.number().int().nullable(),
  /** UTC, ISO 8601 with microseconds; null while the layer has no row. */
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type RegionConfigLayerData = z.output<typeof RegionConfigLayerSchema>;
export class RegionConfigLayer extends createZodDto(RegionConfigLayerSchema) {}

const Source = z.enum(["system", "org", "project"]);
const resolved = <T extends z.ZodType>(value: T) =>
  strict({ value, source: Source });

const EffectiveRegionConfigSchema = strict({
  /** The project resolved for, or null (the organisation alone). */
  projectId: z.string().nullable(),
  currency: resolved(z.string()),
  reportingCurrency: resolved(z.string()),
  language: resolved(z.string()),
  timezone: resolved(z.string()),
  formatLocale: resolved(z.string()),
  units: resolved(z.enum(["metric", "us_customary"])),
  taxProfileId: resolved(z.string().nullable()),
  paymentAdapters: resolved(z.array(z.string())),
  accountingAdapter: resolved(z.string().nullable()),
  rateLibrary: resolved(z.string().nullable()),
  sessionIdleSeconds: resolved(z.number().int()),
});
export type EffectiveRegionConfigData = z.output<
  typeof EffectiveRegionConfigSchema
>;
export class EffectiveRegionConfig extends createZodDto(
  EffectiveRegionConfigSchema,
) {}
