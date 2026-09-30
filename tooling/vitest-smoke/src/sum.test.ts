import { expect, test } from "vitest";
import { sum } from "./sum.js";

test("adds numbers", () => {
  expect(sum([1, 2, 3])).toBe(6);
});
