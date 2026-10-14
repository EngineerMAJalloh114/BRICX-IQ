// Bounded building blocks (architect item 4): a string's length is checked
// before its format check runs, an array's length and an object's key count
// before any element or field is read. Issue messages are i18n keys
// ("validation:<code>") or, for currency, @bricx/money's own codes; never
// input text. Internal: not in the exports map.
import { z } from "zod";
import type { ValidationCode } from "./codes.ts";
import { LIMITS } from "./limits.ts";

/** A format: a length cap and a check that runs only within the cap. */
export interface Format {
  readonly max: number;
  check(value: string): boolean;
}

/** The issue message for a validation code: its i18n key. */
export const issueMessage = (code: ValidationCode): string =>
  `validation:${code}`;

/** zod's `error` option: required for a missing value, else `message`. */
export const typeError =
  (message: string) =>
  (issue: { readonly input?: unknown }): string =>
    issue.input === undefined ? issueMessage("required") : message;

/**
 * A string schema: over `format.max` characters is rejected with `message`
 * without running `format.check`; then the check. Nothing is trimmed.
 * `invalid` picks the message for a failed check (default: `message`).
 */
export function boundedString(
  format: Format,
  message: string,
  invalid?: (value: string) => string,
) {
  return z.string({ error: typeError(message) }).check((ctx) => {
    if (ctx.value.length > format.max) {
      ctx.issues.push({
        code: "custom",
        message,
        input: undefined,
        continue: false,
      });
      return;
    }
    if (!format.check(ctx.value)) {
      ctx.issues.push({
        code: "custom",
        message: invalid === undefined ? message : invalid(ctx.value),
        input: undefined,
        continue: false,
      });
    }
  });
}

/** Counts own enumerable keys, stopping as soon as `max` is passed. */
function exceedsKeys(value: object, max: number): boolean {
  let count = 0;
  for (const key in value) {
    if (Object.hasOwn(value, key)) {
      count += 1;
      if (count > max) return true;
    }
  }
  return false;
}

/**
 * Rejects an object with more than LIMITS.objectKeys own keys before
 * `inner` reads any field; anything else goes to `inner` unchanged.
 */
export function boundedObject<T extends z.ZodType>(inner: T) {
  return z
    .unknown()
    .check((ctx) => {
      const value = ctx.value;
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        exceedsKeys(value, LIMITS.objectKeys)
      ) {
        ctx.issues.push({
          code: "custom",
          message: issueMessage("too_large"),
          input: undefined,
          continue: false,
        });
      }
    })
    .pipe(inner);
}

/**
 * An array of at most `max` items: a longer array is rejected before any
 * element is read.
 */
export function boundedArray<T extends z.ZodType>(item: T, max: number) {
  return z
    .unknown()
    .check((ctx) => {
      if (Array.isArray(ctx.value) && ctx.value.length > max) {
        ctx.issues.push({
          code: "custom",
          message: issueMessage("too_large"),
          input: undefined,
          continue: false,
        });
      }
    })
    .pipe(z.array(item, { error: typeError(issueMessage("invalid_value")) }));
}
