// The standard error envelope (P3-04 D9, architect item 5, ruling 6). The
// body is compatible with RFC 9457 (application/problem+json: every member
// is an extension, there is no title or detail text):
//
//   { status, code, key, traceId?, issues?: [{ path, code, key }], truncated? }
//
// It carries codes, paths and i18n keys only: never message text from zod,
// @bricx/money or @bricx/i18n, never an input value. The client renders
// `key` (errors:validation_failed takes `fields`, the number of issues) and
// each issue's key. Path segments are schema-declared property names or
// array indices; anything else, a record key above all, is "*".
import { MONEY_ERROR_CODES } from "@bricx/money/errors";
import type { MoneyErrorCode } from "@bricx/money/errors";
import { z } from "zod";
import {
  boundedArray,
  boundedObject,
  boundedString,
  issueMessage,
  typeError,
} from "./bounded.ts";
import {
  ERROR_CODES,
  ERROR_KEYS,
  ERROR_STATUS,
  ISSUE_CODES,
  VALIDATION_CODES,
  isIssueCode,
  issueKey,
} from "./codes.ts";
import type { ErrorCode, IssueCode, ValidationCode } from "./codes.ts";
import { FORMATS } from "./formats.ts";
import { LIMITS } from "./limits.ts";
import { sanitizePath } from "./path.ts";
import type { PathSegment } from "./path.ts";
import type { MessageKey } from "@bricx/i18n/keys";

/**
 * The trace id: the API's correlation id (x-request-id), 1-128 characters
 * of [A-Za-z0-9._-] (P4-07, ADR 0057; a W3C trace id fits).
 */
export const TraceIdSchema = boundedString(
  FORMATS.traceId,
  issueMessage("invalid_value"),
).brand<"TraceId">();
export type TraceId = z.output<typeof TraceIdSchema>;

export interface EnvelopeIssue {
  readonly path: readonly PathSegment[];
  readonly code: IssueCode;
  readonly key: MessageKey;
}

export interface ErrorEnvelope {
  readonly status: number;
  readonly code: ErrorCode;
  readonly key: MessageKey;
  readonly traceId?: TraceId;
  readonly issues?: readonly EnvelopeIssue[];
  readonly truncated?: true;
}

export interface EnvelopeOptions {
  readonly traceId?: TraceId;
}

/** An envelope without issues: forbidden, not_found, generic... */
export function errorEnvelope(
  code: ErrorCode,
  options: EnvelopeOptions = {},
): ErrorEnvelope {
  return {
    status: ERROR_STATUS[code],
    code,
    key: ERROR_KEYS[code],
    ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
  };
}

const VALIDATION_SET: ReadonlySet<string> = new Set(VALIDATION_CODES);
const MONEY_SET: ReadonlySet<string> = new Set(MONEY_ERROR_CODES);
// @bricx/money's MoneyJsonSchema reports these two outside MoneyErrorCode.
const MONEY_SCHEMA_EXTRA: Readonly<Record<string, ValidationCode>> = {
  unknown_key: "unknown_field",
  not_an_object: "invalid_value",
};

/**
 * The issue code for a zod issue message. Only known messages map to
 * themselves: "validation:<code>", a MoneyError code, or one of money's two
 * schema messages. Anything else (zod's English text, a custom message) is
 * invalid_value; the text itself is never kept.
 */
export function issueCodeOf(message: string): IssueCode {
  if (message.startsWith("validation:")) {
    const code = message.slice("validation:".length);
    if (VALIDATION_SET.has(code) && isIssueCode(code)) return code;
  }
  if (MONEY_SET.has(message)) {
    const code = `money.${message as MoneyErrorCode}` as const;
    if (isIssueCode(code)) return code;
  }
  return MONEY_SCHEMA_EXTRA[message] ?? "invalid_value";
}

/**
 * The per-parse error map parseAtBoundary uses for issues a schema left to
 * zod (a plain z.string() inside a caller's object): required for a missing
 * value, unknown_field for extra keys, else invalid_value. Schema-level
 * messages win over it.
 */
const boundaryError = (issue: {
  readonly code?: string;
  readonly input?: unknown;
}): string =>
  issue.code === "unrecognized_keys"
    ? issueMessage("unknown_field")
    : typeError(issueMessage("invalid_value"))(issue);

/** The validation_failed envelope for a ZodError raised by `schema`. */
export function validationEnvelope(
  schema: z.core.$ZodType,
  error: z.ZodError,
  options: EnvelopeOptions = {},
): ErrorEnvelope {
  const all = error.issues;
  const issues = all.slice(0, LIMITS.issues).map((issue): EnvelopeIssue => {
    const code = issueCodeOf(issue.message);
    return {
      path: sanitizePath(schema, issue.path),
      code,
      key: issueKey(code),
    };
  });
  return {
    ...errorEnvelope("validation_failed", options),
    issues,
    ...(all.length > LIMITS.issues ? { truncated: true as const } : {}),
  };
}

export type BoundaryResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly envelope: ErrorEnvelope };

/** Parses `input` with `schema`; a failure becomes a validation_failed envelope. */
export function parseAtBoundary<T extends z.ZodType>(
  schema: T,
  input: unknown,
  options: EnvelopeOptions = {},
): BoundaryResult<z.output<T>> {
  const result = schema.safeParse(input, { error: boundaryError });
  return result.success
    ? { success: true, data: result.data }
    : {
        success: false,
        envelope: validationEnvelope(schema, result.error, options),
      };
}

const objectError = (issue: {
  readonly code?: string;
  readonly input?: unknown;
}) =>
  issue.code === "unrecognized_keys"
    ? issueMessage("unknown_field")
    : typeError(issueMessage("invalid_value"))(issue);

const PathSegmentSchema = z.union(
  [
    boundedString(
      { max: LIMITS.pathSegment, check: () => true },
      issueMessage("invalid_value"),
    ),
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ],
  { error: typeError(issueMessage("invalid_value")) },
);

const IssueSchema = boundedObject(
  z
    .strictObject(
      {
        path: boundedArray(PathSegmentSchema, LIMITS.pathDepth),
        code: z.enum(ISSUE_CODES as [IssueCode, ...IssueCode[]], {
          error: typeError(issueMessage("invalid_value")),
        }),
        key: z.string({ error: typeError(issueMessage("invalid_value")) }),
      },
      { error: objectError },
    )
    .check((ctx) => {
      if (ctx.value.key !== issueKey(ctx.value.code)) {
        ctx.issues.push({
          code: "custom",
          message: issueMessage("invalid_value"),
          input: undefined,
          path: ["key"],
        });
      }
    }),
);

/**
 * The envelope as the client re-parses it: every field bounded, the key and
 * status must match the code, each issue's key must match its code.
 */
export const ErrorEnvelopeSchema = boundedObject(
  z
    .strictObject(
      {
        status: z.number({ error: typeError(issueMessage("invalid_value")) }),
        code: z.enum(ERROR_CODES, {
          error: typeError(issueMessage("invalid_value")),
        }),
        key: z.string({ error: typeError(issueMessage("invalid_value")) }),
        traceId: TraceIdSchema.optional(),
        issues: boundedArray(IssueSchema, LIMITS.issues).optional(),
        truncated: z.literal(true).optional(),
      },
      { error: objectError },
    )
    .check((ctx) => {
      const { code, key, status } = ctx.value;
      if (key !== ERROR_KEYS[code] || status !== ERROR_STATUS[code]) {
        ctx.issues.push({
          code: "custom",
          message: issueMessage("invalid_value"),
          input: undefined,
        });
      }
    }),
);
