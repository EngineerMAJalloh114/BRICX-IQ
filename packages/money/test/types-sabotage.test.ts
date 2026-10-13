// Sabotage for the type test (P3 rule 1, permanent): compiles
// types.test-d.ts with the TypeScript compiler API, first against the real
// src/ (no diagnostics), then against a copy of src/money.ts whose
// fromMinor also accepts `number`. The sabotaged program must report the
// expect-error directive above `fromMinor(1, usd)` as unused (TS2578).
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const pkgDir = path.join(import.meta.dirname, "..");
const typeTest = path.join(pkgDir, "test/types.test-d.ts");
const moneySrc = path.join(pkgDir, "src/money.ts");

function diagnostics(
  overrides: ReadonlyMap<string, string>,
): readonly ts.Diagnostic[] {
  const configPath = path.join(pkgDir, "tsconfig.json");
  const config = ts.readConfigFile(configPath, (f) => ts.sys.readFile(f));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, pkgDir);
  const host = ts.createCompilerHost(parsed.options);
  const readFile = host.readFile.bind(host);
  host.readFile = (file) => overrides.get(path.resolve(file)) ?? readFile(file);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, lang, onError) => {
    const text = overrides.get(path.resolve(file));
    return text === undefined
      ? getSourceFile(file, lang, onError)
      : ts.createSourceFile(file, text, lang);
  };
  const program = ts.createProgram([typeTest], parsed.options, host);
  return ts.getPreEmitDiagnostics(program, program.getSourceFile(typeTest));
}

const lineOf = (d: ts.Diagnostic) =>
  d.file === undefined || d.start === undefined
    ? -1
    : d.file.getLineAndCharacterOfPosition(d.start).line + 1;

const typeTestLines = readFileSync(typeTest, "utf8").split("\n");
const expectErrorLine =
  typeTestLines.findIndex((l) => l.includes("a JS number is not an amount")) +
  1;

describe("type test sabotage", () => {
  it("the real source compiles types.test-d.ts with no diagnostics", () => {
    const found = diagnostics(new Map());
    expect(
      found.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    ).toEqual([]);
  }, 60_000);

  it("a fromMinor that accepts number makes the @ts-expect-error unused (TS2578)", () => {
    const original = readFileSync(moneySrc, "utf8");
    const sabotaged = original.replace(
      "amount: bigint | string,",
      "amount: bigint | string | number,",
    );
    expect(sabotaged).not.toBe(original);
    const found = diagnostics(new Map([[moneySrc, sabotaged]]));
    expect(
      found.some((d) => d.code === 2578 && lineOf(d) === expectErrorLine),
    ).toBe(true);
  }, 60_000);
});
