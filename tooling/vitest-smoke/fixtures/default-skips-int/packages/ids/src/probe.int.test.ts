import { expect, test } from "vitest";

// Only an integration test: the default (unit) preset must skip it, so
// this fixture has zero unit tests and must fail.
test("integration probe", () => {
  expect(1).toBe(1);
});
