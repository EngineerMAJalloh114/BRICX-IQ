// P4-05 (ADR 0055): what AuditService.record() accepts. before and after
// are JSON with no floats (money is a string), no NUL, well-formed strings,
// depth <= 32 and <= 64 KiB canonical each; action and entity_type are
// dotted lower-case names; ip is a host address (no mask, no zone); geo is
// integer micro-degrees (condition 2). Errors name the field and never
// echo the input. No database.
import { describe, expect, it, test } from "vitest";
import {
  AuditEventError,
  MAX_JSON_BYTES,
  MAX_JSON_DEPTH,
  validateAuditEvent,
  validateOrigin,
} from "../src/modules/audit/audit-event.js";

const NUL = String.fromCharCode(0);
const LONE_SURROGATE = String.fromCharCode(0xd800);
const SECRET = "s3cr3t-input-marker";

const event = {
  action: "project.task.update",
  entityType: "project.task",
  entityId: "0199e1a0-0000-7000-8000-0000000000e1",
  before: { title: "Foundation", amount: { minor: "150000", currency: "SLE" } },
  after: {
    title: "Foundation pour",
    done: true,
    count: 3,
    note: null,
    tags: ["a"],
  },
};

/** The error validateAuditEvent(input) throws, or undefined. */
function eventError(input: unknown): AuditEventError | undefined {
  try {
    validateAuditEvent(input);
    return undefined;
  } catch (error) {
    if (error instanceof AuditEventError) return error;
    throw error;
  }
}

function originError(input: unknown): AuditEventError | undefined {
  try {
    validateOrigin(input);
    return undefined;
  } catch (error) {
    if (error instanceof AuditEventError) return error;
    throw error;
  }
}

const nested = (depth: number): unknown => {
  let value: unknown = "leaf";
  for (let i = 0; i < depth; i += 1) value = { k: value };
  return value;
};

describe("validateAuditEvent", () => {
  it("accepts a valid event and returns a frozen copy with nulls for absent fields", () => {
    const valid = validateAuditEvent(event);
    expect(valid).toEqual({
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      before: event.before,
      after: event.after,
    });
    expect(Object.isFrozen(valid)).toBe(true);
    expect(
      validateAuditEvent({
        action: "org.member.invite",
        entityType: "org.member",
      }),
    ).toEqual({
      action: "org.member.invite",
      entityType: "org.member",
      entityId: null,
      before: null,
      after: null,
    });
  });

  it(`accepts depth ${String(MAX_JSON_DEPTH)} and exactly ${String(MAX_JSON_BYTES)} canonical bytes`, () => {
    expect(
      eventError({ ...event, after: nested(MAX_JSON_DEPTH - 1) }),
    ).toBeUndefined();
    // {"k":"<x...>"} is 8 bytes of framing.
    const exact = { k: "x".repeat(MAX_JSON_BYTES - 8) };
    expect(eventError({ ...event, after: exact })).toBeUndefined();
  });

  test.each<[string, unknown, string]>([
    ["not an object", "event", "event"],
    ["an array", [event], "event"],
    ["an unknown field", { ...event, extra: 1 }, "event"],
    ["action missing", { ...event, action: undefined }, "action"],
    ["action not dotted", { ...event, action: "update" }, "action"],
    [
      "action upper case",
      { ...event, action: "Project.Task.Update" },
      "action",
    ],
    [
      "action with an empty part",
      { ...event, action: "project..update" },
      "action",
    ],
    ["action too long", { ...event, action: `a.${"b".repeat(127)}` }, "action"],
    ["action with NUL", { ...event, action: `project.task${NUL}` }, "action"],
    ["entityType not dotted", { ...event, entityType: "task" }, "entityType"],
    [
      "entityType upper case",
      { ...event, entityType: "Project.Task" },
      "entityType",
    ],
    [
      "entityId upper case",
      { ...event, entityId: event.entityId.toUpperCase() },
      "entityId",
    ],
    ["entityId not a uuid", { ...event, entityId: SECRET }, "entityId"],
    ["a float", { ...event, after: { amount: 1.5 } }, "after"],
    ["an unsafe integer", { ...event, after: { n: 2 ** 53 } }, "after"],
    ["NaN", { ...event, before: { n: Number.NaN } }, "before"],
    ["Infinity", { ...event, before: [Number.POSITIVE_INFINITY] }, "before"],
    ["NUL in a string", { ...event, after: { note: `a${NUL}b` } }, "after"],
    ["NUL in a key", { ...event, after: { [`k${NUL}`]: 1 } }, "after"],
    [
      "a lone surrogate",
      { ...event, after: { note: LONE_SURROGATE } },
      "after",
    ],
    [
      "a lone surrogate in a key",
      { ...event, after: { [LONE_SURROGATE]: 1 } },
      "after",
    ],
    ["a Date", { ...event, after: { at: new Date(0) } }, "after"],
    [
      "a class instance",
      {
        ...event,
        after: new (class Thing {
          a = 1;
        })(),
      },
      "after",
    ],
    ["a function", { ...event, after: { f: () => 1 } }, "after"],
    ["undefined inside", { ...event, after: { u: undefined } }, "after"],
    ["undefined in an array", { ...event, after: [undefined] }, "after"],
    ["a bigint", { ...event, after: { b: 1n } }, "after"],
    ["a symbol", { ...event, after: { s: Symbol("x") } }, "after"],
    ["too deep", { ...event, after: nested(MAX_JSON_DEPTH) }, "after"],
    [
      "too large",
      { ...event, after: { k: "x".repeat(MAX_JSON_BYTES - 7) } },
      "after",
    ],
    [
      "too large in multi-byte characters",
      { ...event, before: { k: "€".repeat(22_000) } },
      "before",
    ],
  ])(
    "refuses %s (field %s) without echoing the input",
    (_name, input, field) => {
      const error = eventError(input);
      expect(error).toBeInstanceOf(AuditEventError);
      expect(error?.code).toBe("audit.invalid_event");
      expect(error?.field).toBe(field);
      expect(error?.message).toBe(`audit event refused: invalid ${field}`);
      expect(error?.message).not.toContain(SECRET);
    },
  );

  it("refuses a cycle without overflowing the stack", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(eventError({ ...event, after: cyclic })?.field).toBe("after");
  });

  it("bounds the walk: a huge array is refused before it is serialised", () => {
    const huge = new Array<number>(1_000_000).fill(1);
    expect(eventError({ ...event, after: huge })?.field).toBe("after");
  });
});

describe("validateOrigin", () => {
  const origin = {
    correlationId: "req-42",
    ip: "203.0.113.7",
    deviceId: "0199e1a0-0000-7000-8000-0000000000de",
    geo: { latE6: 8_484_146, lonE6: -13_234_442 },
  };

  it("accepts a full origin; geo becomes {lat_e6, lon_e6} integers", () => {
    expect(validateOrigin(origin)).toEqual({
      correlationId: "req-42",
      ip: "203.0.113.7",
      deviceId: origin.deviceId,
      geo: { lat_e6: 8_484_146, lon_e6: -13_234_442 },
    });
  });

  it("accepts IPv6 and IPv4-mapped IPv6 host addresses, and absent optional fields", () => {
    expect(validateOrigin({ ...origin, ip: "2001:DB8::1" }).ip).toBe(
      "2001:DB8::1",
    );
    expect(validateOrigin({ ...origin, ip: "::ffff:203.0.113.7" }).ip).toBe(
      "::ffff:203.0.113.7",
    );
    expect(
      validateOrigin({
        correlationId: "req-1",
        ip: undefined,
        deviceId: undefined,
        geo: undefined,
      }),
    ).toEqual({ correlationId: "req-1", ip: null, deviceId: null, geo: null });
    expect(
      validateOrigin({
        ...origin,
        geo: { latE6: 90_000_000, lonE6: -180_000_000 },
      }).geo,
    ).toEqual({
      lat_e6: 90_000_000,
      lon_e6: -180_000_000,
    });
  });

  test.each<[string, unknown, string]>([
    ["not an object", null, "origin"],
    [
      "correlationId with a space",
      { ...origin, correlationId: "a b" },
      "correlationId",
    ],
    [
      "correlationId too long",
      { ...origin, correlationId: "a".repeat(129) },
      "correlationId",
    ],
    ["correlationId empty", { ...origin, correlationId: "" }, "correlationId"],
    ["ip with a mask", { ...origin, ip: "10.0.0.0/8" }, "ip"],
    ["ip /32 written out", { ...origin, ip: "10.0.0.1/32" }, "ip"],
    ["ip with a zone", { ...origin, ip: "fe80::1%eth0" }, "ip"],
    ["ip not an address", { ...origin, ip: SECRET }, "ip"],
    [
      "deviceId upper case",
      { ...origin, deviceId: origin.deviceId.toUpperCase() },
      "deviceId",
    ],
    [
      "geo as floats",
      { ...origin, geo: { latE6: 8.484146, lonE6: -13.234442 } },
      "geo",
    ],
    [
      "geo latitude out of range",
      { ...origin, geo: { latE6: 90_000_001, lonE6: 0 } },
      "geo",
    ],
    [
      "geo longitude out of range",
      { ...origin, geo: { latE6: 0, lonE6: -180_000_001 } },
      "geo",
    ],
    [
      "geo with an extra key",
      { ...origin, geo: { latE6: 0, lonE6: 0, alt: 1 } },
      "geo",
    ],
    [
      "geo as decimal strings",
      { ...origin, geo: { latE6: "1", lonE6: "2" } },
      "geo",
    ],
  ])(
    "refuses %s (field %s) without echoing the input",
    (_name, input, field) => {
      const error = originError(input);
      expect(error).toBeInstanceOf(AuditEventError);
      expect(error?.field).toBe(field);
      expect(error?.message).not.toContain(SECRET);
    },
  );
});
