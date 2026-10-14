// The committed src/generated/keys.ts (change 4) is exactly what the
// generator makes from the en catalogs; i18n:check fails when it is stale
// (fixture stale-generated).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RESOURCES } from "../src/catalog.ts";
import { MESSAGE_ARGS } from "../src/generated/keys.ts";
import { generateKeysModule } from "../src/keys-gen.ts";
import { NAMESPACES } from "../src/locale.ts";

const pkgDir = path.join(import.meta.dirname, "..");
const committed = readFileSync(
  path.join(pkgDir, "src/generated/keys.ts"),
  "utf8",
);

describe("src/generated/keys.ts", () => {
  it("equals the generator's output for the en catalogs", () => {
    expect(committed).toBe(generateKeysModule(RESOURCES.en));
  });

  it("lists every en key as ns:key, and nothing else", () => {
    const expected = NAMESPACES.flatMap((ns) =>
      Object.keys(RESOURCES.en[ns]).map((k) => `${ns}:${k}`),
    ).sort();
    expect(Object.keys(MESSAGE_ARGS).sort()).toEqual(expected);
  });

  it("maps ICU kinds: plural and selectordinal and number -> number, select -> select, simple -> string", () => {
    expect(MESSAGE_ARGS["field:defects_open"]).toEqual({ defects: "number" });
    expect(MESSAGE_ARGS["field:floor_ordinal"]).toEqual({ floor: "number" });
    expect(MESSAGE_ARGS["validation:too_long"]).toEqual({ max: "number" });
    expect(MESSAGE_ARGS["construction:site_status"]).toEqual({
      status: "select",
    });
    expect(MESSAGE_ARGS["common:welcome_user"]).toEqual({ name: "string" });
    expect(MESSAGE_ARGS["common:save"]).toEqual({});
  });

  it("is deterministic: namespaces in NAMESPACES order, keys and arguments sorted", () => {
    const reordered = Object.fromEntries(
      [...NAMESPACES]
        .reverse()
        .map((ns) => [
          ns,
          Object.fromEntries(Object.entries(RESOURCES.en[ns]).reverse()),
        ]),
    );
    expect(generateKeysModule(reordered)).toBe(committed);
  });

  it("is prettier- and eslint-ignored, so the generator alone owns its layout", () => {
    const root = path.join(pkgDir, "../..");
    expect(readFileSync(path.join(root, ".prettierignore"), "utf8")).toContain(
      "packages/i18n/src/generated/",
    );
    expect(
      readFileSync(path.join(root, "eslint.config.mjs"), "utf8"),
    ).toContain('"packages/i18n/src/generated/**"');
  });
});
