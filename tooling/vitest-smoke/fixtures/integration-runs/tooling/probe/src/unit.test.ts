import { expect, test } from "vitest";

// Fails on purpose: the integration preset must not run unit tests.
test("unit test that must not run", () => {
  expect("ran").toBe("never run by integrationPreset");
});
