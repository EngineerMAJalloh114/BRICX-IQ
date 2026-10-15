// P4-01: the .js -> .ts fallback applies only to relative imports from
// files under packages/, and only after normal resolution failed.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { tsFallbackResolver } from "../src/common/ts-resolve.js";

const packagesDir = path.join(path.sep, "repo", "packages") + path.sep;
const resolve = tsFallbackResolver<{ parentURL?: string }, string>(packagesDir);
const from = (file: string) => ({ parentURL: pathToFileURL(file).href });

/** A resolver that knows only the given specifiers. */
const only =
  (...known: string[]) =>
  (specifier: string) => {
    if (known.includes(specifier)) return `resolved:${specifier}`;
    throw new Error(`not found: ${specifier}`);
  };

describe("tsFallbackResolver", () => {
  test("normal resolution wins", () => {
    expect(
      resolve("./a.js", from("/repo/packages/x/src/b.ts"), only("./a.js")),
    ).toBe("resolved:./a.js");
  });

  test("a missing relative .js under packages/ falls back to .ts", () => {
    expect(
      resolve("./a.js", from("/repo/packages/x/src/b.ts"), only("./a.ts")),
    ).toBe("resolved:./a.ts");
    expect(
      resolve(
        "../c/a.js",
        from("/repo/packages/x/src/b.ts"),
        only("../c/a.ts"),
      ),
    ).toBe("resolved:../c/a.ts");
  });

  test.each([
    ["outside packages/", "./a.js", from("/repo/apps/api/dist/b.js")],
    ["under node_modules", "./a.js", from("/repo/node_modules/x/b.js")],
    ["a bare specifier", "x.js", from("/repo/packages/x/src/b.ts")],
    ["not .js", "./a.mjs", from("/repo/packages/x/src/b.ts")],
    ["no parent", "./a.js", {}],
    ["a non-file parent", "./a.js", { parentURL: "data:text/javascript,1" }],
  ])("no fallback for %s", (_label, specifier, context) => {
    expect(() => resolve(specifier, context, only("./a.ts", "x.ts"))).toThrow(
      /not found/,
    );
  });
});
