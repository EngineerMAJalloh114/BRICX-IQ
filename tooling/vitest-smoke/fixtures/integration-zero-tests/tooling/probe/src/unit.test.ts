import { expect, test } from "vitest";

// A unit test only: the integration preset must not run it, so this
// fixture has zero integration tests and must fail.
test("unit", () => {
  expect(1).toBe(1);
});
