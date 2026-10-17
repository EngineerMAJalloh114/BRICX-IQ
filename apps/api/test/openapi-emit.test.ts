// P4-08 (ADR 0058, decision 4): `pnpm --filter @bricx/api openapi:emit`
// writes packages/api-client/openapi.json from a throwaway app built
// with stub probes, no database and a fixed in-code configuration, so
// the document never carries an environment value. Two emissions are
// byte-equal; the committed file equals what the sources build (CI runs
// `pnpm gen:api && git diff --exit-code -- packages/api-client` too).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  EMIT_ENV,
  OPENAPI_OUTPUT_PATH,
  emitOpenApiDocument,
} from "../src/openapi/emit.js";
import { apiEnv } from "./env.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

describe("openapi:emit", () => {
  test("writes packages/api-client/openapi.json", () => {
    expect(OPENAPI_OUTPUT_PATH).toBe(
      path.join(repoRoot, "packages/api-client/openapi.json"),
    );
  });

  test("emits the same bytes twice, with no environment or placeholder value in them", async () => {
    const first = await emitOpenApiDocument();
    const second = await emitOpenApiDocument();
    expect(first).toBe(second);
    expect(first.startsWith('{\n  "openapi": "3.1.0"')).toBe(true);
    const values = [...Object.values(EMIT_ENV), ...Object.values(apiEnv())];
    for (const value of values) {
      if (value.length >= 8) expect(first).not.toContain(value);
    }
    expect(first).not.toMatch(/localhost|127\.0\.0\.1|postgres:\/\//);
  });

  test("the committed openapi.json equals the document the sources build", async () => {
    const built = await emitOpenApiDocument();
    expect(readFileSync(OPENAPI_OUTPUT_PATH, "utf8")).toBe(built);
  });
});
