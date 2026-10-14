// Error envelope (P3-04 D9, architect item 5, ruling 6): RFC 9457-compatible
// { status, code, key, traceId?, issues?, truncated? }. Codes, paths and
// i18n keys only: no message text, no input value, and path segments are
// only schema-declared property names or array indices; a segment from a
// user-controlled record key becomes "*".
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EmailSchema } from "../src/email.ts";
import {
  ErrorEnvelopeSchema,
  TraceIdSchema,
  errorEnvelope,
  parseAtBoundary,
  validationEnvelope,
} from "../src/error-envelope.ts";
import { GeoPointSchema } from "../src/geo.ts";
import { LIMITS } from "../src/limits.ts";
import { LanguageTagSchema } from "../src/locale.ts";
import { MoneySchema } from "../src/money.ts";
import { PhoneE164Schema } from "../src/phone.ts";

const TRACE = TraceIdSchema.parse("4bf92f3577b34da6a3ce929d0e0e4736");

const Contact = z.strictObject({
  email: EmailSchema,
  phone: PhoneE164Schema.optional(),
  site: GeoPointSchema,
  budget: MoneySchema,
  tags: z.array(z.string()).max(3),
  labels: z.record(z.string(), z.string()),
  nested: z.object({ deep: z.array(z.strictObject({ name: z.string() })) }),
});

function envelopeFor(schema: z.ZodType, input: unknown) {
  const result = parseAtBoundary(schema, input, { traceId: TRACE });
  expect(result.success).toBe(false);
  if (result.success) throw new Error("expected a rejection");
  return result.envelope;
}

describe("errorEnvelope", () => {
  it("carries status, code and key, plus a trace id when given", () => {
    expect(errorEnvelope("not_found")).toEqual({
      status: 404,
      code: "not_found",
      key: "errors:not_found",
    });
    expect(errorEnvelope("forbidden", { traceId: TRACE })).toEqual({
      status: 403,
      code: "forbidden",
      key: "errors:forbidden",
      traceId: TRACE,
    });
  });

  it("TraceIdSchema is 32 lowercase hex digits, not all zero (W3C)", () => {
    expect(TraceIdSchema.safeParse("0".repeat(32)).success).toBe(false);
    expect(
      TraceIdSchema.safeParse("4BF92F3577B34DA6A3CE929D0E0E4736").success,
    ).toBe(false);
    expect(TraceIdSchema.safeParse("4bf92f35").success).toBe(false);
    expect(TraceIdSchema.safeParse(TRACE).success).toBe(true);
  });
});

describe("parseAtBoundary", () => {
  it("returns the data on success", () => {
    expect(parseAtBoundary(EmailSchema, "A@Example.com")).toEqual({
      success: true,
      data: "a@example.com",
    });
  });

  it("builds a validation_failed envelope with one issue per problem", () => {
    const envelope = envelopeFor(Contact, {
      email: "not an email",
      phone: "+1 202 555 0123",
      site: { lat: 100, lng: 0 },
      budget: { amount: "1.50", currency: "USD" },
      tags: ["a"],
      labels: {},
      nested: { deep: [{ name: "x" }, { name: 5 }] },
      extra: true,
    });
    expect(envelope).toEqual({
      status: 422,
      code: "validation_failed",
      key: "errors:validation_failed",
      traceId: TRACE,
      issues: [
        {
          path: ["email"],
          code: "invalid_email",
          key: "validation:invalid_email",
        },
        {
          path: ["phone"],
          code: "invalid_phone",
          key: "validation:invalid_phone",
        },
        {
          path: ["site", "lat"],
          code: "invalid_latitude",
          key: "validation:invalid_latitude",
        },
        {
          path: ["budget", "amount"],
          code: "money.invalid_amount",
          key: "errors:money.invalid_amount",
        },
        {
          path: ["nested", "deep", 1, "name"],
          code: "invalid_value",
          key: "validation:invalid_value",
        },
        { path: [], code: "unknown_field", key: "validation:unknown_field" },
      ],
    });
    expect(ErrorEnvelopeSchema.parse(envelope)).toEqual(envelope);
  });

  it("a missing field is required, a wrong type invalid_value, from zod's own schemas too", () => {
    const Schema = z.strictObject({ name: z.string(), count: z.number() });
    expect(envelopeFor(Schema, { count: "3" }).issues).toEqual([
      { path: ["name"], code: "required", key: "validation:required" },
      {
        path: ["count"],
        code: "invalid_value",
        key: "validation:invalid_value",
      },
    ]);
  });

  it("maps money's own unknown_key and not_an_object messages", () => {
    expect(
      envelopeFor(MoneySchema, { amount: "1", currency: "USD", x: 1 }).issues,
    ).toEqual([
      { path: [], code: "unknown_field", key: "validation:unknown_field" },
    ]);
    expect(envelopeFor(MoneySchema, "1 USD").issues).toEqual([
      { path: [], code: "invalid_value", key: "validation:invalid_value" },
    ]);
  });

  it("money currency codes become money.<code>", () => {
    expect(
      envelopeFor(MoneySchema, { amount: "1", currency: "SLL" }).issues,
    ).toEqual([
      {
        path: ["currency"],
        code: "money.historical_currency",
        key: "errors:money.historical_currency",
      },
    ]);
  });

  it("no message text from any package reaches the envelope (ruling 4, item 5)", () => {
    const json = JSON.stringify(envelopeFor(LanguageTagSchema, "en_GB"));
    expect(json).not.toMatch(/BCP 47|well-formed|Invalid input|expected/);
    const zodText = JSON.stringify(
      envelopeFor(z.strictObject({ a: z.string().min(5) }), { a: "abc" }),
    );
    expect(zodText).not.toMatch(/Too small|characters|expected/i);
  });
});

describe("path segments (ruling 6)", () => {
  // A made-up secret, not shaped like any provider's key (gitleaks scans tests).
  const secret = "attacker-secret-DO-NOT-LEAK-7f3a9c41";

  it("a record key with a secret never appears anywhere in the envelope JSON", () => {
    const envelope = envelopeFor(Contact, {
      email: "a@example.com",
      site: { lat: 0, lng: 0 },
      budget: { amount: "1", currency: "USD" },
      tags: [],
      labels: { [secret]: 42 },
      nested: { deep: [] },
    });
    expect(envelope.issues).toEqual([
      {
        path: ["labels", "*"],
        code: "invalid_value",
        key: "validation:invalid_value",
      },
    ]);
    expect(JSON.stringify(envelope).includes(secret)).toBe(false);
    expect(JSON.stringify(envelope).includes("SECRET")).toBe(false);
  });

  it("an unknown key with a secret name is reported without its name", () => {
    const envelope = envelopeFor(GeoPointSchema, {
      lat: 0,
      lng: 0,
      [secret]: 1,
    });
    expect(envelope.issues).toEqual([
      { path: [], code: "unknown_field", key: "validation:unknown_field" },
    ]);
    expect(JSON.stringify(envelope).includes(secret)).toBe(false);
  });

  it("property: no record key ever reaches the envelope", () => {
    const Schema = z.strictObject({
      meta: z.record(z.string(), z.strictObject({ v: z.number() })),
    });
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 6, maxLength: 40 })
          .filter((k) => k !== "__proto__"),
        (key) => {
          const result = parseAtBoundary(Schema, {
            meta: { [key]: { v: "x" } },
          });
          if (result.success) return false;
          const json = JSON.stringify(result.envelope);
          return (
            !json.includes(JSON.stringify(key).slice(1, -1)) &&
            JSON.stringify(result.envelope.issues?.[0]?.path) ===
              '["meta","*","v"]'
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it("a declared property name is kept even through optional, union, pipe, lazy, tuple and intersection", () => {
    const Inner = z.strictObject({ code: z.string() });
    const Lazy: z.ZodType = z.lazy(() =>
      z.strictObject({ child: Lazy.optional(), n: z.number() }),
    );
    const Schema = z.strictObject({
      a: Inner.optional(),
      b: z.union([Inner, z.number()]),
      c: z
        .string()
        .transform((s) => s.length)
        .pipe(z.number().max(1)),
      d: Lazy,
      e: z.tuple([z.string(), Inner]),
      f: z.intersection(
        z.object({ x: z.string() }),
        z.object({ y: z.number() }),
      ),
    });
    const envelope = envelopeFor(Schema, {
      a: { code: 1 },
      b: { code: 2 },
      c: "abc",
      d: { child: { n: "x" }, n: 1 },
      e: ["x", { code: 3 }],
      f: { x: 1, y: 2 },
    });
    expect(envelope.issues?.map((i) => i.path)).toEqual([
      ["a", "code"],
      ["b"],
      ["c"],
      ["d", "child", "n"],
      ["e", 1, "code"],
      ["f", "x"],
    ]);
  });

  it("a path deeper than 32 segments is cut to 32", () => {
    type Node = { next?: Node | undefined; v: number };
    const NodeSchema: z.ZodType<Node> = z.lazy(() =>
      z.strictObject({ next: NodeSchema.optional(), v: z.number() }),
    );
    let input: { next?: unknown; v: unknown } = { v: "bad" };
    for (let i = 0; i < 40; i += 1) input = { next: input, v: 1 };
    const issues = envelopeFor(NodeSchema, input).issues ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toHaveLength(LIMITS.pathDepth);
  });

  it("more than 100 issues keep the first 100 and set truncated", () => {
    const Schema = z.array(z.number()).max(500);
    const envelope = envelopeFor(
      Schema,
      Array.from({ length: 150 }, () => "x"),
    );
    expect(envelope.issues).toHaveLength(LIMITS.issues);
    expect(envelope.truncated).toBe(true);
    expect(ErrorEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });
});

describe("validationEnvelope", () => {
  it("builds the same envelope from a ZodError the caller already has", () => {
    const result = EmailSchema.safeParse("x");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(validationEnvelope(EmailSchema, result.error)).toEqual({
      status: 422,
      code: "validation_failed",
      key: "errors:validation_failed",
      issues: [
        { path: [], code: "invalid_email", key: "validation:invalid_email" },
      ],
    });
  });
});

describe("ErrorEnvelopeSchema (the client re-parses what the server sends)", () => {
  it.each([
    [
      "status that does not match the code",
      { status: 400, code: "not_found", key: "errors:not_found" },
    ],
    [
      "key that does not match the code",
      { status: 404, code: "not_found", key: "errors:generic" },
    ],
    ["unknown code", { status: 418, code: "teapot", key: "errors:teapot" }],
    [
      "message text",
      { status: 404, code: "not_found", key: "errors:not_found", detail: "x" },
    ],
    [
      "issue key that does not match its code",
      {
        status: 422,
        code: "validation_failed",
        key: "errors:validation_failed",
        issues: [
          { path: [], code: "invalid_email", key: "validation:invalid_phone" },
        ],
      },
    ],
    [
      "issue with an unknown code",
      {
        status: 422,
        code: "validation_failed",
        key: "errors:validation_failed",
        issues: [{ path: [], code: "nope", key: "validation:nope" }],
      },
    ],
    [
      "101 issues",
      {
        status: 422,
        code: "validation_failed",
        key: "errors:validation_failed",
        issues: Array.from({ length: 101 }, () => ({
          path: [],
          code: "required",
          key: "validation:required",
        })),
      },
    ],
    [
      "a 33-segment path",
      {
        status: 422,
        code: "validation_failed",
        key: "errors:validation_failed",
        issues: [
          {
            path: Array.from({ length: 33 }, () => 0),
            code: "required",
            key: "validation:required",
          },
        ],
      },
    ],
    [
      "a 129-character segment",
      {
        status: 422,
        code: "validation_failed",
        key: "errors:validation_failed",
        issues: [
          {
            path: ["a".repeat(129)],
            code: "required",
            key: "validation:required",
          },
        ],
      },
    ],
    [
      "a negative index",
      {
        status: 422,
        code: "validation_failed",
        key: "errors:validation_failed",
        issues: [{ path: [-1], code: "required", key: "validation:required" }],
      },
    ],
    [
      "a bad trace id",
      {
        status: 404,
        code: "not_found",
        key: "errors:not_found",
        traceId: "abc",
      },
    ],
  ])("rejects %s", (_label, input) => {
    expect(ErrorEnvelopeSchema.safeParse(input).success).toBe(false);
  });
});
