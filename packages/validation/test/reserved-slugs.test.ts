// P6-02 (ADR 0072; owner ruling R5, D14): the committed reserved-slug list.
// The names below are written by hand from R5 and the task plan; they are
// not derived from src/reserved-slugs.ts.
import { describe, expect, it } from "vitest";
import {
  ORGANIZATION_SLUG_PATTERN,
  RESERVED_SLUGS,
  isReservedSlug,
} from "../src/reserved-slugs.ts";

/** R5's names, verbatim. */
const R5 = [
  "www",
  "api",
  "app",
  "admin",
  "auth",
  "bricx",
  "directory",
  "help",
  "login",
  "mail",
  "root",
  "status",
  "support",
];

describe("ORGANIZATION_SLUG_PATTERN", () => {
  it("is directory.org_directory's and bricx.organizations' CHECK", () => {
    expect(ORGANIZATION_SLUG_PATTERN.source).toBe(
      "^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$",
    );
  });

  it.each([["acme"], ["a-1"], ["abc"], ["0rg"], ["a".repeat(63)]])(
    "accepts %s",
    (slug) => {
      expect(ORGANIZATION_SLUG_PATTERN.test(slug)).toBe(true);
    },
  );

  it.each([
    [""],
    ["ab"],
    ["-acme"],
    ["acme-"],
    ["Acme"],
    ["ac_me"],
    ["ac me"],
    ["a".repeat(64)],
    ["acmé"],
  ])("refuses %j", (slug) => {
    expect(ORGANIZATION_SLUG_PATTERN.test(slug)).toBe(false);
  });
});

describe("RESERVED_SLUGS", () => {
  it("holds every R5 name", () => {
    for (const name of R5) expect(RESERVED_SLUGS).toContain(name);
  });

  it("is about fifty names, sorted, unique, frozen, each a valid slug", () => {
    expect(RESERVED_SLUGS.length).toBeGreaterThanOrEqual(40);
    expect(RESERVED_SLUGS.length).toBeLessThanOrEqual(80);
    expect([...RESERVED_SLUGS]).toEqual([...RESERVED_SLUGS].sort());
    expect(new Set(RESERVED_SLUGS).size).toBe(RESERVED_SLUGS.length);
    expect(Object.isFrozen(RESERVED_SLUGS)).toBe(true);
    for (const slug of RESERVED_SLUGS) {
      expect(ORGANIZATION_SLUG_PATTERN.test(slug), slug).toBe(true);
    }
  });
});

describe("isReservedSlug()", () => {
  it.each(R5)("%s is reserved", (slug) => {
    expect(isReservedSlug(slug)).toBe(true);
  });

  it.each([["acme"], ["bricx-builders"], ["wwww"], ["api1"], ["my-app"]])(
    "%s is not reserved",
    (slug) => {
      expect(isReservedSlug(slug)).toBe(false);
    },
  );

  it("never matches a prototype name or a non-string", () => {
    expect(isReservedSlug("constructor")).toBe(false);
    expect(isReservedSlug("__proto__")).toBe(false);
    expect(isReservedSlug("toString")).toBe(false);
    expect(isReservedSlug(42)).toBe(false);
    expect(isReservedSlug(undefined)).toBe(false);
  });
});
