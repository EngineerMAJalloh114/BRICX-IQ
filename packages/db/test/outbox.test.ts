// P4-06 (ADR 0056): the outbox topic registry and the payload rules that
// insertOutbox() and the relay share. Every refusal is an OutboxError with
// a code and a fixed message: never the topic, a key or a value.
import { describe, expect, it } from "vitest";
import {
  MAX_PAYLOAD_BYTES,
  MAX_PAYLOAD_DEPTH,
  OUTBOX_TOPICS,
  deliveryBackoffMs,
  OutboxError,
  type OutboxErrorCode,
  outboxTopic,
  validateNotBefore,
  validateOutboxId,
  validateOutboxPayload,
} from "../src/outbox.js";

const ID = "0199e1a0-0000-7000-8000-000000000001";
/** [1, <hole>, 3]: an array with a missing index. */
const sparse: number[] = [];
sparse[0] = 1;
sparse[2] = 3;

function codeOf(run: () => unknown): OutboxErrorCode {
  try {
    run();
  } catch (error) {
    if (error instanceof OutboxError) {
      expect(error.message).toBe(`outbox: ${error.code}`);
      expect(error.name).toBe("OutboxError");
      expect(Object.keys(error)).toEqual(["code"]);
      return error.code;
    }
    throw error;
  }
  throw new Error("expected an OutboxError");
}

/** A registry entry that accepts the keys the generic rules are tested on. */
const open = {
  queue: "test",
  keys: ["a", "b", "c"],
  maxBytes: MAX_PAYLOAD_BYTES,
};

describe("the topic registry", () => {
  it("holds exactly system.ping on queue system, payload {} (ADR 0056), the module template's topic (P4-09), sessions.revoked (P5-03, ADR 0063; cause and delivery options since P5-04), sync.revoke (P5-04, ADR 0065), users.mfa_check (P5-05, ADR 0066) and access_grants.expire (P5-06, ADR 0067)", () => {
    expect(OUTBOX_TOPICS).toEqual({
      "system.ping": { queue: "system", keys: [], maxBytes: 2 },
      "template_items.created": {
        queue: "template_items",
        keys: ["id", "projectId"],
        maxBytes: 128,
      },
      "sessions.revoked": {
        queue: "sessions",
        keys: ["sessionId", "userId", "orgId", "keycloakSid", "cause"],
        maxBytes: 512,
        // About 40 min of retries while Keycloak is down (plan decision 8).
        delivery: { attempts: 40, backoffMs: 1_000, maxBackoffMs: 60_000 },
      },
      "sync.revoke": {
        queue: "sync",
        keys: ["sessionId", "userId", "orgId"],
        maxBytes: 256,
      },
      "users.mfa_check": {
        queue: "users",
        keys: ["userId"],
        maxBytes: 128,
        delivery: { attempts: 40, backoffMs: 1_000, maxBackoffMs: 60_000 },
      },
      "access_grants.expire": {
        queue: "access",
        keys: ["grantId", "userId"],
        maxBytes: 256,
        delivery: { attempts: 40, backoffMs: 1_000, maxBackoffMs: 60_000 },
      },
      // new-module: OUTBOX_TOPICS (pnpm new-module adds an entry above, P4-09)
    });
    expect(Object.isFrozen(OUTBOX_TOPICS)).toBe(true);
    for (const entry of Object.values(OUTBOX_TOPICS)) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.keys)).toBe(true);
      if (entry.delivery !== undefined) {
        expect(Object.isFrozen(entry.delivery)).toBe(true);
      }
    }
  });

  it("delivery options, where set, are bounded: 1-100 attempts, a backoff of 1 s to 1 h that the cap is at least", () => {
    for (const entry of Object.values(OUTBOX_TOPICS)) {
      const delivery = entry.delivery;
      if (delivery === undefined) continue;
      expect(Number.isSafeInteger(delivery.attempts)).toBe(true);
      expect(delivery.attempts).toBeGreaterThanOrEqual(1);
      expect(delivery.attempts).toBeLessThanOrEqual(100);
      expect(delivery.backoffMs).toBeGreaterThanOrEqual(1_000);
      expect(delivery.maxBackoffMs).toBeGreaterThanOrEqual(delivery.backoffMs);
      expect(delivery.maxBackoffMs).toBeLessThanOrEqual(3_600_000);
    }
  });

  it("deliveryBackoffMs(): the attempt's delay, doubling from backoffMs and capped at maxBackoffMs", () => {
    const delivery = { attempts: 40, backoffMs: 1_000, maxBackoffMs: 60_000 };
    expect(
      [1, 2, 3, 6, 7, 8, 40, 1_000].map((n) => deliveryBackoffMs(delivery, n)),
    ).toEqual([1_000, 2_000, 4_000, 32_000, 60_000, 60_000, 60_000, 60_000]);
    expect(deliveryBackoffMs(delivery, 0)).toBe(1_000);
    expect(deliveryBackoffMs(delivery, -5)).toBe(1_000);
  });

  it("every topic matches the table's CHECK and every queue is a plain name", () => {
    for (const [topic, entry] of Object.entries(OUTBOX_TOPICS)) {
      expect(topic).toMatch(/^[a-z][a-z0-9_.]{0,62}$/);
      expect(entry.queue).toMatch(/^[a-z][a-z0-9_-]{0,62}$/);
      expect(entry.maxBytes).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    }
  });

  it("outboxTopic() returns the entry of a registered topic", () => {
    expect(outboxTopic("system.ping")).toBe(OUTBOX_TOPICS["system.ping"]);
  });

  it.each([
    ["an unregistered topic", "system.pong"],
    ["an inherited property", "constructor"],
    ["__proto__", "__proto__"],
    ["toString", "toString"],
    ["an empty string", ""],
    ["a number", 7],
    ["undefined", undefined],
    ["an object", { toString: () => "system.ping" }],
  ])("outboxTopic() refuses %s as unknown_topic", (_what, topic) => {
    expect(codeOf(() => outboxTopic(topic))).toBe("unknown_topic");
  });
});

describe("validateOutboxPayload(topic, payload)", () => {
  it("system.ping: {} is the canonical text {}", () => {
    expect(validateOutboxPayload(outboxTopic("system.ping"), {})).toBe("{}");
    expect(
      validateOutboxPayload(outboxTopic("system.ping"), Object.create(null)),
    ).toBe("{}");
  });

  it("system.ping refuses any key (payloads carry only registered keys)", () => {
    expect(
      codeOf(() => validateOutboxPayload(outboxTopic("system.ping"), { a: 1 })),
    ).toBe("invalid_payload");
  });

  it("accepts nested JSON with safe integers, booleans, null and well-formed strings", () => {
    const payload = {
      a: [1, -2, 0, Number.MAX_SAFE_INTEGER, true, false, null],
      b: { x: "0199e1a0-0000-7000-8000-000000000001", y: "é ✓ 𝄞" },
      c: [],
    };
    expect(validateOutboxPayload(open, payload)).toBe(JSON.stringify(payload));
  });

  it.each<[string, unknown]>([
    ["an array", []],
    ["null", null],
    ["a string", "x"],
    ["a number", 1],
    ["a class instance", new Date(0)],
    ["a Map", new Map()],
    ["an unregistered top-level key", { d: 1 }],
    ["a float", { a: 1.5 }],
    ["negative zero", { a: -0 }],
    ["NaN", { a: Number.NaN }],
    ["Infinity", { a: Number.POSITIVE_INFINITY }],
    ["an unsafe integer", { a: Number.MAX_SAFE_INTEGER + 1 }],
    ["a bigint", { a: 1n }],
    ["undefined", { a: undefined }],
    ["a function", { a: () => 1 }],
    ["a symbol", { a: Symbol("x") }],
    ["NUL in a string", { a: "x\u0000y" }],
    ["NUL in a nested key", { a: { "x\u0000": 1 } }],
    ["a lone surrogate in a string", { a: "\ud800" }],
    ["a lone surrogate in a key", { a: { "\udc00": 1 } }],
    ["a sparse array", { a: sparse }],
    ["an array with an extra property", { a: Object.assign([1], { x: 1 }) }],
    ["a symbol key", { a: { [Symbol("k")]: 1 } }],
    [
      "a getter",
      { a: Object.defineProperty({}, "g", { get: () => 1, enumerable: true }) },
    ],
    [
      "a non-enumerable key",
      { a: Object.defineProperty({}, "h", { value: 1 }) },
    ],
    ["a nested class instance", { a: new Date(0) }],
  ])("refuses %s as invalid_payload", (_what, payload) => {
    expect(codeOf(() => validateOutboxPayload(open, payload))).toBe(
      "invalid_payload",
    );
  });

  it("refuses a cycle without overflowing the stack", () => {
    const a: Record<string, unknown> = {};
    a.a = a;
    expect(codeOf(() => validateOutboxPayload(open, a))).toBe(
      "invalid_payload",
    );
  });

  it(`refuses depth above ${String(MAX_PAYLOAD_DEPTH)}; accepts exactly ${String(MAX_PAYLOAD_DEPTH)}`, () => {
    const nest = (levels: number): unknown => {
      let value: unknown = 1;
      for (let i = 0; i < levels; i += 1) value = [value];
      return { a: value };
    };
    // The top-level object is level 1.
    expect(() =>
      validateOutboxPayload(open, nest(MAX_PAYLOAD_DEPTH - 1)),
    ).not.toThrow();
    expect(
      codeOf(() => validateOutboxPayload(open, nest(MAX_PAYLOAD_DEPTH))),
    ).toBe("invalid_payload");
  });

  it("refuses a payload above the topic's maxBytes as payload_too_large (UTF-8 bytes)", () => {
    const small = { ...open, maxBytes: 16 };
    // {"a":"xxxxxxxxx"} is 17 bytes; {"a":"xxxxxxxx"} is 16.
    expect(validateOutboxPayload(small, { a: "x".repeat(8) })).toHaveLength(16);
    expect(
      codeOf(() => validateOutboxPayload(small, { a: "x".repeat(9) })),
    ).toBe("payload_too_large");
    // Counted in UTF-8 bytes, not UTF-16 units: "é" is 2 bytes.
    expect(
      codeOf(() => validateOutboxPayload(small, { a: "é".repeat(5) })),
    ).toBe("payload_too_large");
  });

  it(`refuses more than ${String(MAX_PAYLOAD_BYTES)} bytes before serialising a huge input`, () => {
    const huge = { a: "x".repeat(50 * 1024 * 1024) };
    expect(codeOf(() => validateOutboxPayload(open, huge))).toBe(
      "payload_too_large",
    );
    const wide = { a: Array.from({ length: 70_000 }, () => 0) };
    expect(codeOf(() => validateOutboxPayload(open, wide))).toBe(
      "payload_too_large",
    );
  });

  it("never echoes the payload in the error", () => {
    const secret = "secret-value-0123456789";
    try {
      validateOutboxPayload(open, { a: 1.5, b: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });
});

describe("validateOutboxId(id)", () => {
  it("accepts a canonical lower-case UUIDv7", () => {
    expect(validateOutboxId(ID)).toBe(ID);
  });

  it.each<[string, unknown]>([
    ["upper case", ID.toUpperCase()],
    ["a UUIDv4", "3f2b8c1e-9a4d-4c2b-8e1f-6d5a4b3c2d1e"],
    ["the wrong variant", "0199e1a0-0000-7000-c000-000000000001"],
    ["no dashes", ID.replaceAll("-", "")],
    ["a number", 1],
    ["undefined", undefined],
  ])("refuses %s as invalid_id", (_what, id) => {
    expect(codeOf(() => validateOutboxId(id))).toBe("invalid_id");
  });
});

describe("validateNotBefore(value) (P5-06, D-G, ADR 0067)", () => {
  it("undefined and null mean no delay (null); an RFC 3339 UTC instant with milliseconds passes through", () => {
    expect(validateNotBefore(undefined)).toBeNull();
    expect(validateNotBefore(null)).toBeNull();
    expect(validateNotBefore("2026-10-22T09:00:00.000Z")).toBe(
      "2026-10-22T09:00:00.000Z",
    );
  });

  it.each([
    "2026-10-22T09:00:00Z",
    "2026-10-22T09:00:00.000+01:00",
    "2026-10-22 09:00:00.000Z",
    "not a date",
    "",
    1_761_123_600_000,
    new Date("2026-10-22T09:00:00.000Z"),
    "9999-12-31T23:59:59.999Z ",
    "2026-13-01T00:00:00.000Z",
  ])("refuses %s with invalid_not_before, naming no value", (value) => {
    let caught: unknown;
    try {
      validateNotBefore(value);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OutboxError);
    expect(caught).toMatchObject({
      code: "invalid_not_before",
      message: "outbox: invalid_not_before",
    });
  });
});
