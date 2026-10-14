// Bounds before parsing (architect item 4, ruling 8): every string is
// length-checked before its format check runs, every array's length and
// every object's key count before any element or field is read. Proved by
// work done (the format check, element and field reads are never reached)
// with a generous ratio backstop; no millisecond limits (CI runs about 4x
// slower than a laptop).
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CountryCodeSchema } from "../src/country.ts";
import { CurrencySchema } from "../src/currency.ts";
import { EmailSchema } from "../src/email.ts";
import { ErrorEnvelopeSchema, TraceIdSchema } from "../src/error-envelope.ts";
import { FORMATS } from "../src/formats.ts";
import { GeoPointSchema } from "../src/geo.ts";
import { LIMITS } from "../src/limits.ts";
import { LanguageTagSchema, SupportedLocaleSchema } from "../src/locale.ts";
import {
  CursorSchema,
  PageLimitSchema,
  PageQuerySchema,
  pageOf,
} from "../src/pagination.ts";
import { PhoneE164Schema } from "../src/phone.ts";
import { TimeZoneSchema } from "../src/time-zone.ts";
import { messagesOf } from "./helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const MB = 1_000_000;
const huge = (ch: string) => ch.repeat(MB);

const stringCases: readonly [
  string,
  z.ZodType,
  keyof typeof FORMATS,
  string,
][] = [
  ["EmailSchema", EmailSchema, "email", "validation:invalid_email"],
  ["PhoneE164Schema", PhoneE164Schema, "phone", "validation:invalid_phone"],
  [
    "CountryCodeSchema",
    CountryCodeSchema,
    "country",
    "validation:invalid_country",
  ],
  ["CurrencySchema", CurrencySchema, "currency", "invalid_currency"],
  [
    "TimeZoneSchema",
    TimeZoneSchema,
    "timeZone",
    "validation:invalid_time_zone",
  ],
  [
    "LanguageTagSchema",
    LanguageTagSchema,
    "languageTag",
    "validation:invalid_language_tag",
  ],
  [
    "SupportedLocaleSchema",
    SupportedLocaleSchema,
    "languageTag",
    "validation:invalid_language_tag",
  ],
  ["CursorSchema", CursorSchema, "cursor", "validation:invalid_cursor"],
  [
    "PageLimitSchema",
    PageLimitSchema,
    "pageLimit",
    "validation:invalid_page_size",
  ],
  ["TraceIdSchema", TraceIdSchema, "traceId", "validation:invalid_value"],
];

describe("strings: the format check never runs on an over-long string", () => {
  it.each(stringCases)("%s", (_name, schema, format, message) => {
    const check = vi.spyOn(FORMATS[format], "check");
    expect(messagesOf(schema, huge("a"))).toEqual([message]);
    expect(check).not.toHaveBeenCalled();
    // Control: a short input does reach the check.
    schema.safeParse("a");
    expect(check).toHaveBeenCalled();
  });

  it("every format has a cap well below 1 MB", () => {
    for (const [name, spec] of Object.entries(FORMATS)) {
      expect(spec.max, name).toBeLessThanOrEqual(512);
    }
  });
});

/** Median time of `runs` batches of `batch` calls. */
function medianTime(fn: () => void, runs = 9, batch = 50): number {
  const times: number[] = [];
  for (let r = 0; r < runs; r += 1) {
    const start = performance.now();
    for (let i = 0; i < batch; i += 1) fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(runs / 2)] ?? 0;
}

describe("strings: ratio backstop (1 MB vs a 100-character input)", () => {
  it.each(stringCases)("%s", (_name, schema) => {
    const bigInput = huge("a");
    const small = "a".repeat(100);
    medianTime(() => schema.safeParse(bigInput), 2, 10); // warm up
    const big = medianTime(() => schema.safeParse(bigInput));
    const base = medianTime(() => schema.safeParse(small));
    // 10,000x more input; a linear scan would be ~10,000x slower. Generous:
    // within 50x of the small case (a length check is O(1)).
    expect(big).toBeLessThan(Math.max(base, 0.05) * 50);
  });
});

/** An object whose `reads` counts every field value read through a getter. */
function countingObject(keys: number, fields: readonly string[]) {
  const counter = { reads: 0 };
  const obj: Record<string, unknown> = {};
  for (const field of fields) {
    Object.defineProperty(obj, field, {
      enumerable: true,
      get() {
        counter.reads += 1;
        return 0;
      },
    });
  }
  for (let i = 0; i < keys; i += 1) obj[`k${String(i)}`] = i;
  return { obj, counter };
}

describe("objects: too many keys is rejected before any field is read", () => {
  it.each([
    ["GeoPointSchema", GeoPointSchema, ["lat", "lng"]],
    ["PageQuerySchema", PageQuerySchema, ["cursor", "limit"]],
    ["ErrorEnvelopeSchema", ErrorEnvelopeSchema, ["status", "code", "key"]],
    ["pageOf", pageOf(z.string()), ["items", "nextCursor"]],
  ] as const)("%s", (_name, schema, fields) => {
    const { obj, counter } = countingObject(100_000, fields);
    expect(messagesOf(schema, obj)).toEqual(["validation:too_large"]);
    expect(counter.reads).toBe(0);
    // Control: within the cap, the fields are read.
    const small = countingObject(0, fields);
    schema.safeParse(small.obj);
    expect(small.counter.reads).toBeGreaterThan(0);
  });

  it("the key cap is 16", () => {
    expect(LIMITS.objectKeys).toBe(16);
  });
});

/** A proxy over an array that counts element reads (not length). */
function countingArray(length: number) {
  const counter = { reads: 0 };
  const target: unknown[] = new Array<unknown>(length).fill("x");
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) counter.reads += 1;
      return Reflect.get(t, prop, receiver) as unknown;
    },
  });
  return { proxy, counter };
}

describe("arrays: too many elements is rejected before any element is read", () => {
  it("pageOf items above 100", () => {
    const { proxy, counter } = countingArray(1_000_000);
    expect(
      messagesOf(pageOf(z.string()), { items: proxy, nextCursor: null }),
    ).toEqual(["validation:too_large"]);
    expect(counter.reads).toBe(0);
  });

  it("envelope issues above 100 and paths above 32", () => {
    const issues = countingArray(1_000_000);
    expect(
      ErrorEnvelopeSchema.safeParse({
        status: 422,
        code: "validation_failed",
        key: "errors:validation_failed",
        issues: issues.proxy,
      }).success,
    ).toBe(false);
    expect(issues.counter.reads).toBe(0);
    const pathArray = countingArray(1_000_000);
    expect(
      ErrorEnvelopeSchema.safeParse({
        status: 422,
        code: "validation_failed",
        key: "errors:validation_failed",
        issues: [
          {
            path: pathArray.proxy,
            code: "required",
            key: "validation:required",
          },
        ],
      }).success,
    ).toBe(false);
    expect(pathArray.counter.reads).toBe(0);
  });

  it("the caps", () => {
    expect(LIMITS.issues).toBe(100);
    expect(LIMITS.pathDepth).toBe(32);
    expect(LIMITS.pathSegment).toBe(128);
  });
});
