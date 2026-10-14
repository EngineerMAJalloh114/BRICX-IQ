// EmailSchema (P3-04 D5, ruling 5): zod's default email pattern (ASCII),
// at most 254 characters with a local part of at most 64, no trimming, any
// whitespace rejected, output lowercased in full. The lowercase output
// matches Keycloak's own normalisation; it is not an RFC 5321 guarantee
// (the local part is case-sensitive in the RFC).
import { describe, expect, it } from "vitest";
import { EMAIL_MAX, EMAIL_LOCAL_MAX, EmailSchema } from "../src/email.ts";
import { expectRejectedWithoutEcho, messageOf, parsed } from "./helpers.ts";

const INVALID = "validation:invalid_email";

describe("EmailSchema accepts", () => {
  it.each([
    ["a@example.com", "a@example.com"],
    ["First.Last@Example.COM", "first.last@example.com"],
    ["user+tag@sub.example.org", "user+tag@sub.example.org"],
    ["o'brien@example.ie", "o'brien@example.ie"],
    ["x@xn--bcher-kva.example", "x@xn--bcher-kva.example"],
    ["UPPER@EXAMPLE.COM", "upper@example.com"],
  ])("%s as %s", (input, output) => {
    expect(parsed(EmailSchema, input)).toBe(output);
  });

  it("is idempotent: the output parses to itself", () => {
    const once = parsed(EmailSchema, "Mixed.Case@Example.Com");
    expect(parsed(EmailSchema, once)).toBe(once);
  });

  it("accepts exactly 64 characters of local part and 254 in total", () => {
    const local = "a".repeat(EMAIL_LOCAL_MAX);
    expect(parsed(EmailSchema, `${local}@example.com`)).toBe(
      `${local}@example.com`,
    );
    const domain = `${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.com`;
    const total = `${"a".repeat(EMAIL_MAX - domain.length - 1)}@${domain}`;
    expect(total.length).toBe(EMAIL_MAX);
    expect(parsed(EmailSchema, total)).toBe(total);
  });
});

describe("EmailSchema rejects", () => {
  it.each([
    ["no at sign", "user.example.com"],
    ["empty", ""],
    ["no local part", "@example.com"],
    ["no domain", "user@"],
    ["single-label domain", "user@localhost"],
    ["leading dot", ".user@example.com"],
    ["double dot", "us..er@example.com"],
    ["two at signs", "a@b@example.com"],
    ["unicode local part (ASCII only in v1)", "jöhn@example.com"],
    ["unicode domain (send punycode)", "user@bücher.example"],
    ["IP literal", "user@[127.0.0.1]"],
    ["quoted local part", '"a b"@example.com'],
  ])("%s", (_label, input) => {
    expect(expectRejectedWithoutEcho(EmailSchema, input)).toEqual([INVALID]);
  });

  it.each([
    ["leading space", " user@example.com"],
    ["trailing space", "user@example.com "],
    ["trailing newline", "user@example.com\n"],
    ["tab inside", "us\ter@example.com"],
    ["no-break space", "user@example.com "],
  ])("whitespace is never trimmed: %s", (_label, input) => {
    expect(expectRejectedWithoutEcho(EmailSchema, input)).toEqual([INVALID]);
  });

  it("65 characters of local part", () => {
    const input = `${"a".repeat(EMAIL_LOCAL_MAX + 1)}@example.com`;
    expect(expectRejectedWithoutEcho(EmailSchema, input)).toEqual([INVALID]);
  });

  it("255 characters in total", () => {
    const domain = `${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.com`;
    const input = `${"a".repeat(EMAIL_MAX - domain.length)}@${domain}`;
    expect(input.length).toBe(EMAIL_MAX + 1);
    expect(expectRejectedWithoutEcho(EmailSchema, input)).toEqual([INVALID]);
  });

  it.each([
    ["number", 5],
    ["null", null],
    ["object", {}],
  ])("a %s", (_label, input) => {
    expect(messageOf(EmailSchema, input)).toBe(INVALID);
  });

  it("undefined as required", () => {
    expect(messageOf(EmailSchema, undefined)).toBe("validation:required");
  });
});
