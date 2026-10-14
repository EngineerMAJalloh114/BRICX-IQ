import {
  defaultPreset,
  integrationPreset,
  swcPreset,
} from "@bricx/vitest-config";
import { expect, test } from "vitest";

// Unit tests run under load in `pnpm verify` (every package at once), where
// Vitest's 5000 ms default timed out slow but correct tests. The unit presets
// carry their own ceiling; the fixtures unit-timeout-* prove Vitest honours it.
const packageDir = import.meta.dirname;

test("defaultPreset sets 60 s test and hook timeouts", () => {
  const { test: config } = defaultPreset({ packageDir });
  expect(config.testTimeout).toBe(60_000);
  expect(config.hookTimeout).toBe(60_000);
});

test("swcPreset sets 60 s test and hook timeouts", () => {
  const { test: config } = swcPreset({ packageDir });
  expect(config.testTimeout).toBe(60_000);
  expect(config.hookTimeout).toBe(60_000);
});

test("integrationPreset keeps its own 120 s test and 300 s hook timeouts", () => {
  const { test: config } = integrationPreset({ packageDir });
  expect(config.testTimeout).toBe(120_000);
  expect(config.hookTimeout).toBe(300_000);
});
