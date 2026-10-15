// P4-01: the correlation id rule, on its own.
import { isUuidV7 } from "@bricx/ids/uuid-v7";
import { describe, expect, test } from "vitest";
import { requestIdGenerator } from "../src/common/request-id.js";

describe("requestIdGenerator", () => {
  const next = requestIdGenerator({ now: () => 1_760_000_000_000 });

  test("keeps a header of 1-128 safe characters", () => {
    expect(next("abc")).toBe("abc");
    expect(next("A-z_0.9")).toBe("A-z_0.9");
    expect(next("a".repeat(128))).toBe("a".repeat(128));
  });

  test.each([
    undefined,
    "",
    "a".repeat(129),
    "a b",
    "a/b",
    "a:b",
    "é",
    ["a", "b"],
  ])("replaces %j with a UUIDv7", (header) => {
    expect(isUuidV7(next(header))).toBe(true);
  });

  test("generated ids are strictly increasing", () => {
    const a = next(undefined);
    const b = next(undefined);
    expect(b > a).toBe(true);
  });
});
