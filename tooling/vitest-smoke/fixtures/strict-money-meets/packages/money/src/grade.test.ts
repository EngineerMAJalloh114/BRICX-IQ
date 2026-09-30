import { expect, test } from "vitest";
import { grade } from "./grade.js";

test("takes both branches", () => {
  expect(grade(60)).toBe("pass");
  expect(grade(40)).toBe("fail");
});
