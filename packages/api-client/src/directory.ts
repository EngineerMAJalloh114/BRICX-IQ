// resolveCell() (P6-01, ADR 0071, D6 and C6): asks the global directory
// which cell serves an organisation, before the client knows its API or
// has a token. P7-05 wires it into sign-in. It lives outside src/generated/
// (orval cleans that folder), and test/directory-gen.test.ts proves that
// gen:api leaves it intact.
// - An e-mail address is sent as its domain only, a slug as itself, both
//   lower-cased and checked against the directory's shapes (mirrored from
//   @bricx/db/directory, which is server-only) before any request.
// - The directory URL is the caller's (EXPO_PUBLIC_DIRECTORY_URL in
//   @bricx/config/client-public): there is no default, and with
//   `production` it must be https.
// - The answer is re-parsed with a strict schema. 404 directory.not_found
//   is CellNotFoundError: there is no default cell. Any other non-2xx is
//   ApiProblem with its envelope. Errors carry a code, never the address,
//   the slug or a URL.
// Client-safe: zod, the envelope schema and the fetcher only; fetch is
// injected (globalThis.fetch when absent).
import { ErrorEnvelopeSchema } from "@bricx/validation/error-envelope";
import { z } from "zod";
import { ApiProblem } from "./fetcher.ts";

/** Which cell serves an organisation, and where its API and Keycloak are. */
export interface CellRoute {
  readonly cell: string;
  readonly apiBaseUrl: string;
  readonly keycloakUrl: string;
}

/** An e-mail address (only its domain is sent) or an organisation slug. */
export type CellLookup = { readonly email: string } | { readonly slug: string };

export interface ResolveCellOptions {
  /** The directory's base URL; required, never defaulted. */
  readonly directoryUrl: string;
  /** The fetch to use (globalThis.fetch when absent). */
  readonly fetch?: typeof fetch;
  /** Production: the directory and the cell's URLs must be https. */
  readonly production?: boolean;
}

export type DirectoryClientCode =
  /** A malformed e-mail address or slug (nothing was sent). */
  | "invalid_lookup"
  /** The directory URL is missing, not http(s), has credentials, or is not https in production. */
  | "insecure_url"
  /** The directory answered 200 with something that is not exactly a cell route. */
  | "invalid_response";

/** No organisation uses this slug or e-mail domain. There is no default cell. */
export class CellNotFoundError extends Error {
  constructor() {
    super("directory: no cell found");
  }
}
Object.defineProperty(CellNotFoundError.prototype, "name", {
  value: "CellNotFoundError",
});

/** resolveCell() refused: a code, never a value. */
export class DirectoryClientError extends Error {
  readonly code: DirectoryClientCode;

  constructor(code: DirectoryClientCode) {
    super(`directory client: ${code}`);
    this.code = code;
  }
}
Object.defineProperty(DirectoryClientError.prototype, "name", {
  value: "DirectoryClientError",
});

// The directory's shapes (packages/db/src/directory.ts, the table CHECKs).
const ORG_SLUG_MAX = 63;
const EMAIL_DOMAIN_MAX = 253;
/** RFC 5321: the longest address a mailbox can have. */
const EMAIL_MAX = 320;
const ORG_SLUG = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const EMAIL_DOMAIN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CELL_ID = /^[a-z]{2}(?:-[a-z]+)+-[0-9]+$/;

/** The query the directory takes, or undefined for a malformed lookup. */
function queryOf(lookup: CellLookup): string | undefined {
  if ("slug" in lookup) {
    const slug = lookup.slug;
    if (typeof slug !== "string" || slug.length > ORG_SLUG_MAX) {
      return undefined;
    }
    const normal = slug.toLowerCase();
    return ORG_SLUG.test(normal)
      ? `org_slug=${encodeURIComponent(normal)}`
      : undefined;
  }
  const email = lookup.email;
  if (typeof email !== "string" || email.length > EMAIL_MAX) return undefined;
  const parts = email.split("@");
  if (parts.length !== 2 || parts[0] === "") return undefined;
  const domain = (parts[1] ?? "").toLowerCase().replace(/\.$/, "");
  return domain.length <= EMAIL_DOMAIN_MAX && EMAIL_DOMAIN.test(domain)
    ? `email_domain=${encodeURIComponent(domain)}`
    : undefined;
}

/** A URL with no credentials, http(s) (https only in production). */
function isServiceUrl(value: string, production: boolean): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    (url.protocol === "https:" || (!production && url.protocol === "http:")) &&
    url.username === "" &&
    url.password === ""
  );
}

const routeSchema = (production: boolean) =>
  z.strictObject({
    cell: z.string().max(32).regex(CELL_ID),
    apiBaseUrl: z
      .string()
      .max(2048)
      .refine((v) => isServiceUrl(v, production)),
    keycloakUrl: z
      .string()
      .max(2048)
      .refine((v) => isServiceUrl(v, production)),
  });

/**
 * The cell serving `lookup`. Throws DirectoryClientError (invalid_lookup,
 * insecure_url, invalid_response), CellNotFoundError, or ApiProblem.
 */
export async function resolveCell(
  lookup: CellLookup,
  options: ResolveCellOptions,
): Promise<CellRoute> {
  const production = options.production === true;
  const base = options.directoryUrl;
  if (typeof base !== "string" || !isServiceUrl(base, production)) {
    throw new DirectoryClientError("insecure_url");
  }
  const query = queryOf(lookup);
  if (query === undefined) throw new DirectoryClientError("invalid_lookup");
  const doFetch = options.fetch ?? globalThis.fetch;
  const response = await doFetch(
    `${base.replace(/\/+$/, "")}/v1/directory/resolve?${query}`,
    { method: "GET", headers: { accept: "application/json" } },
  );
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const envelope = ErrorEnvelopeSchema.safeParse(body);
    if (
      response.status === 404 &&
      envelope.success &&
      envelope.data.code === "directory.not_found"
    ) {
      throw new CellNotFoundError();
    }
    throw new ApiProblem(
      response.status,
      envelope.success ? envelope.data : undefined,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DirectoryClientError("invalid_response");
  }
  const route = routeSchema(production).safeParse(body);
  if (!route.success) throw new DirectoryClientError("invalid_response");
  return route.data;
}
