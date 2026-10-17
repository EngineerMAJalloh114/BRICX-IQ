// P4-08 (ADR 0058, owner condition 1): the idempotency store keeps the
// WIRE form of a handler's result, so a replay sends what the first
// answer sent. wireFormOf(handler) reads the handler's ZodResponse /
// ZodSerializerDto metadata: a codec DTO encodes (Money -> { amount:
// string }), a plain DTO or schema parses, an array DTO applies to each
// element, and no DTO is the identity (a bigint there fails at
// JSON.stringify: 500 generic, never a stored bigint).
import { fromMinor } from "@bricx/money/money";
import { ZodSerializerDto, createZodDto } from "nestjs-zod";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { Money } from "../src/common/dto/money.dto.js";
import {
  SERIALIZER_METADATA,
  wireFormOf,
} from "../src/common/idempotency/wire.js";

class Report extends createZodDto(z.strictObject({ n: z.number() })) {}
const Plain = z.object({ s: z.string() });

class Handlers {
  @ZodSerializerDto(Money)
  money() {
    return fromMinor(1n, "USD");
  }

  @ZodSerializerDto([Money])
  monies() {
    return [fromMinor(1n, "USD")];
  }

  @ZodSerializerDto(Report)
  report() {
    return { n: 1 };
  }

  @ZodSerializerDto(Plain)
  plain() {
    return { s: "x" };
  }

  none() {
    return { any: 1n };
  }
}

/** The decorated method itself (its metadata), not a bound call. */
const handler = (name: keyof Handlers): object => {
  const descriptor = Object.getOwnPropertyDescriptor(Handlers.prototype, name);
  const method: unknown = descriptor?.value;
  if (typeof method !== "function") throw new Error(`no method ${name}`);
  return method;
};

describe("wireFormOf(handler)", () => {
  test("pins nestjs-zod's metadata key", () => {
    expect(SERIALIZER_METADATA).toBe("ZOD_SERIALIZER_DTO_OPTIONS");
    expect(Reflect.getMetadata(SERIALIZER_METADATA, handler("money"))).toBe(
      Money,
    );
  });

  test("a codec DTO: wire encodes to JSON, unwire decodes it back", () => {
    const form = wireFormOf(handler("money"));
    const money = fromMinor(-1250n, "EUR");
    const wire = form.wire(money);
    expect(wire).toEqual({ amount: "-1250", currency: "EUR" });
    expect(JSON.stringify(wire)).toBe('{"amount":"-1250","currency":"EUR"}');
    expect(form.unwire(JSON.parse(JSON.stringify(wire)))).toEqual(money);
  });

  test("an array codec DTO applies to every element", () => {
    const form = wireFormOf(handler("monies"));
    const list = [fromMinor(1n, "USD"), fromMinor(2n, "USD")];
    const wire = form.wire(list);
    expect(wire).toEqual([
      { amount: "1", currency: "USD" },
      { amount: "2", currency: "USD" },
    ]);
    expect(form.unwire(wire)).toEqual(list);
  });

  test("a plain DTO or schema: wire parses (strips what the schema drops), unwire is the identity", () => {
    const report = wireFormOf(handler("report"));
    expect(report.wire({ n: 2 })).toEqual({ n: 2 });
    expect(() => report.wire({ n: "2" })).toThrow();
    const plain = wireFormOf(handler("plain"));
    expect(plain.wire({ s: "x", extra: 1 })).toEqual({ s: "x" });
    expect(plain.unwire({ s: "x" })).toEqual({ s: "x" });
  });

  test("no DTO: both are the identity", () => {
    const form = wireFormOf(handler("none"));
    const value = { any: 1n };
    expect(form.wire(value)).toBe(value);
    expect(form.unwire(value)).toBe(value);
  });
});
