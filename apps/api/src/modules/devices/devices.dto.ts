// Devices' boundary schemas (P5-03, ADR 0063): nestjs-zod DTOs parsed by
// the global ZodValidationPipe (422 validation_failed) and serialized by
// @ZodResponse. The id is the UUIDv7 the device made for itself (CLAUDE.md
// rule 6); the owner never comes from the body. Messages are issue codes.
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

/** The platforms the table's CHECK allows. */
export const PLATFORMS = ["ios", "android", "web"] as const;
/** Most characters in a device name (the table's CHECK says the same). */
export const DEVICE_NAME_MAX = 100;

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

const NameSchema = z
  .string({ error: typeError })
  .min(1, { error: "validation:required" })
  .max(DEVICE_NAME_MAX, { error: "validation:too_large" });

const objectError = (issue: {
  readonly code?: string;
  readonly input?: unknown;
}) =>
  issue.code === "unrecognized_keys"
    ? "validation:unknown_field"
    : typeError(issue);

export const strict = <T extends z.core.$ZodLooseShape>(shape: T) =>
  z.strictObject(shape, { error: objectError });

export class RegisterDevice extends createZodDto(
  strict({
    id: IdSchema,
    platform: z.enum(PLATFORMS, { error: typeError }),
    name: NameSchema,
  }),
) {}

export class DeviceParams extends createZodDto(strict({ id: IdSchema })) {}

const DeviceSchema = strict({
  id: IdSchema,
  platform: z.enum(PLATFORMS),
  name: NameSchema,
  /** UTC, ISO 8601 with microseconds. */
  createdAt: z.string(),
  lastSeenAt: z.string(),
  trusted: z.boolean(),
  revokedAt: z.string().nullable(),
});
export type DeviceData = z.output<typeof DeviceSchema>;

export class Device extends createZodDto(DeviceSchema) {}

/** A user's non-revoked devices, at most DEVICES_MAX_PER_USER (ADR 0063; owner review fix 2). */
export class DeviceList extends createZodDto(
  strict({ items: z.array(DeviceSchema) }),
) {}
