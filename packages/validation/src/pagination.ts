// Pagination (P3-04 D8, ruling 8). The cursor is an opaque base64url string
// (no padding) of at most 512 characters; the API (P4) owns what it holds.
// The limit is an integer 1..100, default 25, given as a number or as a
// strict digit string from a query string ("25"; never coerced, which
// would accept " 25", "2.5e1" or "0x19"). A page is { items, nextCursor },
// nextCursor null on the last page, at most 100 items.
import { z } from "zod";
import {
  boundedArray,
  boundedObject,
  boundedString,
  issueMessage,
  typeError,
} from "./bounded.ts";
import { FORMATS } from "./formats.ts";
import { LIMITS } from "./limits.ts";

export const CURSOR_MAX = LIMITS.cursor;
export const PAGE_LIMIT_DEFAULT = 25;
export const PAGE_LIMIT_MAX = LIMITS.pageItems;

export const CursorSchema = boundedString(
  FORMATS.cursor,
  issueMessage("invalid_cursor"),
).brand<"Cursor">();

export type Cursor = z.output<typeof CursorSchema>;

const INVALID_LIMIT = issueMessage("invalid_page_size");

/** The page size, or undefined if `value` is not one. */
function pageLimit(value: unknown): number | undefined {
  if (value === undefined) return PAGE_LIMIT_DEFAULT;
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    if (
      value.length > FORMATS.pageLimit.max ||
      !FORMATS.pageLimit.check(value)
    ) {
      return undefined;
    }
    n = Number(value);
  } else {
    return undefined;
  }
  return Number.isInteger(n) && n >= 1 && n <= PAGE_LIMIT_MAX ? n : undefined;
}

// .optional() before the transform lets the key be absent in an object
// schema; the transform still runs and gives the default.
export const PageLimitSchema = z
  .unknown()
  .optional()
  .transform((value, ctx): number => {
    const n = pageLimit(value);
    if (n === undefined) {
      ctx.issues.push({
        code: "custom",
        message: INVALID_LIMIT,
        input: undefined,
        continue: false,
      });
      return z.NEVER;
    }
    return n;
  });

const objectError = (issue: {
  readonly code?: string;
  readonly input?: unknown;
}) =>
  issue.code === "unrecognized_keys"
    ? issueMessage("unknown_field")
    : typeError(issueMessage("invalid_value"))(issue);

export const PageQuerySchema = boundedObject(
  z.strictObject(
    { cursor: CursorSchema.optional(), limit: PageLimitSchema },
    { error: objectError },
  ),
);

export type PageQuery = z.output<typeof PageQuerySchema>;

/** A page of `item`: at most 100 items and the next cursor (null at the end). */
export function pageOf<T extends z.ZodType>(item: T) {
  return boundedObject(
    z.strictObject(
      {
        items: boundedArray(item, PAGE_LIMIT_MAX),
        nextCursor: CursorSchema.nullable(),
      },
      { error: objectError },
    ),
  );
}
