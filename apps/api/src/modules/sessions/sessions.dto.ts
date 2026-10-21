// Sessions' boundary schemas (P5-03, ADR 0063). A session is shown with
// its org, device and times; the Keycloak session id never leaves the
// server. Messages are issue codes.
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

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

export class SessionParams extends createZodDto(strict({ id: IdSchema })) {}

export class UserSessionsParams extends createZodDto(
  strict({ userId: IdSchema }),
) {}

const SessionSchema = strict({
  id: IdSchema,
  orgId: IdSchema,
  userId: IdSchema,
  deviceId: IdSchema.nullable(),
  /** UTC, ISO 8601 with microseconds. */
  createdAt: z.string(),
  lastSeenAt: z.string(),
  revokedAt: z.string().nullable(),
  /** True for the session this request runs in. */
  current: z.boolean(),
});
export type SessionData = z.output<typeof SessionSchema>;

export class Session extends createZodDto(SessionSchema) {}

/** A user's open sessions, newest first, at most 100 (ADR 0063; owner review fix 1). */
export class SessionList extends createZodDto(
  strict({ items: z.array(SessionSchema) }),
) {}

/** The ids of the sessions a revoke closed (none when all were closed). */
export class RevokedSessions extends createZodDto(
  strict({ revoked: z.array(IdSchema) }),
) {}
