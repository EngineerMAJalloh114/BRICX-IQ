// The directory route's boundary schemas (P6-01, ADR 0071; owner condition
// C5): nestjs-zod DTOs parsed by the global ZodValidationPipe (422
// validation_failed) and serialized by @ZodResponse. A key is bounded
// before any other work, then normalised (lower-case; one trailing dot
// stripped from a domain) and checked against the shape the directory's
// table CHECKs enforce, so a malformed key never reaches the reader.
// Messages are issue codes, never a client value.
import {
  EMAIL_DOMAIN_MAX,
  ORG_SLUG_MAX,
  isEmailDomain,
  isOrgSlug,
} from "@bricx/db/directory";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

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

/** A key: bounded (one extra character for a domain's trailing dot), then normalised and checked. */
const key = (max: number, check: (value: string) => boolean) =>
  z
    .string({ error: typeError })
    .max(max, { error: "validation:too_large" })
    .transform((value) => value.toLowerCase())
    .refine(check, { error: "validation:invalid_value" });

const OrgSlugSchema = key(ORG_SLUG_MAX, isOrgSlug);
const EmailDomainSchema = key(EMAIL_DOMAIN_MAX + 1, (value) =>
  isEmailDomain(value.endsWith(".") ? value.slice(0, -1) : value),
).transform((value) => (value.endsWith(".") ? value.slice(0, -1) : value));

const ResolveQuerySchema = z
  .strictObject(
    {
      org_slug: OrgSlugSchema.optional(),
      email_domain: EmailDomainSchema.optional(),
    },
    { error: objectError },
  )
  .check((ctx) => {
    const given =
      Number(ctx.value.org_slug !== undefined) +
      Number(ctx.value.email_domain !== undefined);
    if (given !== 1) {
      ctx.issues.push({
        code: "custom",
        message:
          given === 0 ? "validation:required" : "validation:invalid_value",
        input: undefined,
        path: [],
      });
    }
  });

/** ?org_slug= or ?email_domain=, exactly one. */
export class ResolveQuery extends createZodDto(ResolveQuerySchema) {}

/** Which cell serves the organisation; never its id or name. */
export class CellRoute extends createZodDto(
  z.strictObject({
    /** The cell id, e.g. af-south-1. */
    cell: z.string(),
    /** The cell's API base URL. */
    apiBaseUrl: z.string(),
    /** The cell's Keycloak realm URL. */
    keycloakUrl: z.string(),
  }),
) {}
