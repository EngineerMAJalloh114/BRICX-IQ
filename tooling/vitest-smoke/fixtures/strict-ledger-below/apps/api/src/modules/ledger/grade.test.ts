import { expect, test } from "vitest";
import { grade } from "./grade.js";

test("takes the pass branch only", () => {
  expect(grade(60)).toBe("pass");
});
