// Shared test helpers for @bricx/i18n.
import { expect } from "vitest";
import { I18nError } from "../src/errors.ts";
import type { I18nErrorCode } from "../src/errors.ts";

/**
 * A marker that must never appear in an error message (P3 rule 8): tests put
 * it inside the locale tag, key, argument or message they pass in.
 */
export const SENTINEL = "Zq9SentinelXy";

/** Runs `fn`, expects an I18nError with `code`, and returns it. */
export function expectI18nError(
  fn: () => unknown,
  code: I18nErrorCode,
): I18nError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(I18nError);
  const error = caught as I18nError;
  expect(error.code).toBe(code);
  expect(error.message).not.toContain(SENTINEL);
  expect(error.cause).toBeUndefined();
  return error;
}

/** Milliseconds `fn` takes (wall clock; tests use generous budgets). */
export function timed(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

/** Arabic-Indic (U+0660..U+0669) and Extended Arabic-Indic (U+06F0..U+06F9) digits. */
export const ARABIC_INDIC_DIGIT = /[٠-٩۰-۹]/u;

/**
 * A copy of Intl without the named members (Intl's members are not
 * enumerable, so `{ ...Intl }` would copy nothing). For vi.stubGlobal.
 */
export function intlWithout(
  ...names: readonly string[]
): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(Intl)) {
    if (!names.includes(name)) copy[name] = Reflect.get(Intl, name);
  }
  return copy;
}

/** A copy of Intl with `name` replaced by `value`. */
export function intlWith(
  name: string,
  value: unknown,
): Record<string, unknown> {
  return { ...intlWithout(name), [name]: value };
}

/** Intl.Locale#getTextInfo().direction (Node 24; not in TypeScript's ES2022 lib). */
export const textDirection = (locale: Intl.Locale): string =>
  (
    locale as Intl.Locale & { getTextInfo(): { direction: string } }
  ).getTextInfo().direction;
