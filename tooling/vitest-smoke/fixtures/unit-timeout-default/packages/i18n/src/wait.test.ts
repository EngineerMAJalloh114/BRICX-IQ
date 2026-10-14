import { expect, test } from "vitest";
import { wait } from "./wait.js";

test("waits 5.5 s, past Vitest's 5000 ms default", async () => {
  expect(await wait(5_500)).toBe(5_500);
});
