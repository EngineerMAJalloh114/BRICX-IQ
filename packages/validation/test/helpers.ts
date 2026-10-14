// Shared test helpers: the issue messages a schema reports, and the P3 rule 9
// check that no rejection echoes its input.
import { expect } from "vitest";
import type { z } from "zod";

/** The issue messages of a failed parse; fails the test if the parse succeeds. */
export function messagesOf(schema: z.ZodType, input: unknown): string[] {
  const result = schema.safeParse(input);
  expect(result.success, "expected a rejection").toBe(false);
  return result.success ? [] : result.error.issues.map((i) => i.message);
}

/** The one issue message of a failed parse. */
export function messageOf(schema: z.ZodType, input: unknown): string {
  const messages = messagesOf(schema, input);
  expect(messages).toHaveLength(1);
  return messages[0] ?? "";
}

/**
 * Rejects `input` and proves the serialised error carries no part of it
 * (P3 rule 9). Strings shorter than 4 characters are checked as whole JSON
 * string values instead, so "a" does not match inside a message key.
 */
export function expectRejectedWithoutEcho(
  schema: z.ZodType,
  input: unknown,
): string[] {
  const result = schema.safeParse(input);
  expect(result.success, "expected a rejection").toBe(false);
  if (result.success) return [];
  const json = JSON.stringify(result.error.issues);
  if (typeof input === "string" && input.length >= 4) {
    expect(json.includes(input)).toBe(false);
    expect(json.includes(JSON.stringify(input).slice(1, -1))).toBe(false);
  } else if (typeof input === "string") {
    expect(json.includes(JSON.stringify(input))).toBe(false);
  }
  expect(json.includes('"input"')).toBe(false);
  return result.error.issues.map((i) => i.message);
}

/** The successful parse result; fails the test on a rejection. */
export function parsed<T extends z.ZodType>(
  schema: T,
  input: unknown,
): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    expect.fail(`rejected: ${JSON.stringify(result.error.issues)}`);
  }
  return result.data;
}
