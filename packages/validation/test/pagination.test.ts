// Pagination (P3-04 D8, ruling 8): an opaque base64url cursor of at most 512
// characters; limit an integer 1..100, default 25, from a number or a strict
// digit string (query strings), never z.coerce; pageOf(item).
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CURSOR_MAX,
  CursorSchema,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  PageLimitSchema,
  PageQuerySchema,
  pageOf,
} from "../src/pagination.ts";
import { expectRejectedWithoutEcho, messagesOf, parsed } from "./helpers.ts";

describe("CursorSchema", () => {
  it.each(["a", "eyJpZCI6MX0", "AZaz09-_", "x".repeat(CURSOR_MAX)])(
    "accepts %s",
    (input) => {
      expect(parsed(CursorSchema, input)).toBe(input);
    },
  );

  it.each([
    ["empty", ""],
    ["padding", "eyJpZCI6MX0="],
    ["standard base64 +", "ab+c"],
    ["standard base64 /", "ab/c"],
    ["space", "ab c"],
    ["513 characters", "x".repeat(CURSOR_MAX + 1)],
  ])("rejects %s", (_label, input) => {
    expect(expectRejectedWithoutEcho(CursorSchema, input)).toEqual([
      "validation:invalid_cursor",
    ]);
  });
});

describe("PageLimitSchema", () => {
  it("defaults to 25 and caps at 100", () => {
    expect(PAGE_LIMIT_DEFAULT).toBe(25);
    expect(PAGE_LIMIT_MAX).toBe(100);
    expect(parsed(PageLimitSchema, undefined)).toBe(25);
  });

  it.each([
    [1, 1],
    [100, 100],
    ["1", 1],
    ["25", 25],
    ["100", 100],
  ])("accepts %j as %d", (input, output) => {
    expect(parsed(PageLimitSchema, input)).toBe(output);
  });

  it.each([
    ["zero", 0],
    ["101", 101],
    ["negative", -1],
    ["fraction", 2.5],
    ["NaN", Number.NaN],
    ["string zero", "0"],
    ["string 101", "101"],
    ["leading zero", "025"],
    ["plus sign", "+5"],
    ["exponent", "1e1"],
    ["space", " 5"],
    ["decimal string", "5.0"],
    ["hex", "0x10"],
    ["empty", ""],
    ["repeated query param", ["5", "6"]],
    ["null", null],
    ["bigint", 5n],
    ["long digit string", "1".repeat(1000)],
  ])("rejects %s", (_label, input) => {
    expect(messagesOf(PageLimitSchema, input)).toEqual([
      "validation:invalid_page_size",
    ]);
  });
});

describe("PageQuerySchema", () => {
  it("an empty query is the first page of 25", () => {
    expect(parsed(PageQuerySchema, {})).toEqual({ limit: 25 });
  });

  it("parses a cursor and a string limit", () => {
    expect(parsed(PageQuerySchema, { cursor: "abc", limit: "50" })).toEqual({
      cursor: "abc",
      limit: 50,
    });
  });

  it("rejects an unknown parameter", () => {
    expect(messagesOf(PageQuerySchema, { page: "2" })).toEqual([
      "validation:unknown_field",
    ]);
  });
});

describe("pageOf", () => {
  const Page = pageOf(z.strictObject({ id: z.string() }));

  it("parses items and a next cursor", () => {
    expect(parsed(Page, { items: [{ id: "a" }], nextCursor: "abc" })).toEqual({
      items: [{ id: "a" }],
      nextCursor: "abc",
    });
  });

  it("the last page has nextCursor null", () => {
    expect(parsed(Page, { items: [], nextCursor: null })).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it("accepts 100 items, rejects 101 before reading any item", () => {
    const items = Array.from({ length: 100 }, () => ({ id: "x" }));
    expect(parsed(Page, { items, nextCursor: null }).items).toHaveLength(100);
    const tooMany = Array.from({ length: 101 }, () => 7);
    expect(messagesOf(Page, { items: tooMany, nextCursor: null })).toEqual([
      "validation:too_large",
    ]);
  });

  it("requires nextCursor", () => {
    expect(messagesOf(Page, { items: [] })).toEqual(["validation:required"]);
  });
});
