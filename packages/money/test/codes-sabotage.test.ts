// Sabotage for the compile-time agreement between MONEY_ERROR_CODES and the
// MoneyErrorCode union (P3-04, ADR 0047, architect change 7; permanent).
// Compiles src/errors.ts with the TypeScript compiler API: the real file has
// no diagnostics; a copy whose union gains a code the array lacks, and a copy
// whose array gains a code the union lacks, must each fail to compile.
// (The red run before MONEY_ERROR_CODES existed is in the P3-04 proofs.)
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const pkgDir = path.join(import.meta.dirname, "..");
const errorsSrc = path.join(pkgDir, "src/errors.ts");

function diagnostics(text: string): readonly string[] {
  const configPath = path.join(pkgDir, "tsconfig.json");
  const config = ts.readConfigFile(configPath, (f) => ts.sys.readFile(f));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, pkgDir);
  const host = ts.createCompilerHost(parsed.options);
  const readFile = host.readFile.bind(host);
  host.readFile = (file) =>
    path.resolve(file) === errorsSrc ? text : readFile(file);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, lang, onError) =>
    path.resolve(file) === errorsSrc
      ? ts.createSourceFile(file, text, lang)
      : getSourceFile(file, lang, onError);
  const program = ts.createProgram([errorsSrc], parsed.options, host);
  return ts
    .getPreEmitDiagnostics(program, program.getSourceFile(errorsSrc))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

const original = readFileSync(errorsSrc, "utf8");

describe("MONEY_ERROR_CODES and MoneyErrorCode agree (compile time)", () => {
  it("the real errors.ts compiles with no diagnostics", () => {
    expect(diagnostics(original)).toEqual([]);
  }, 60_000);

  // The union and the messages record gain the code, the array does not:
  // only the agreement assertion can catch it.
  it("a code added to the union (with a message) but not the array fails to compile", () => {
    const sabotaged = original
      .replace(
        '  | "invalid_locale";',
        '  | "invalid_locale"\n  | "fake_code";',
      )
      .replace(
        '  invalid_locale: "not a locale Intl.NumberFormat accepts",',
        '  invalid_locale: "not a locale Intl.NumberFormat accepts",\n  fake_code: "a fake code",',
      );
    expect(sabotaged).not.toBe(original);
    expect(diagnostics(sabotaged).length).toBeGreaterThan(0);
  }, 60_000);

  it("a code added to the array only fails to compile", () => {
    const sabotaged = original.replace(
      "export const MONEY_ERROR_CODES = Object.freeze([",
      'export const MONEY_ERROR_CODES = Object.freeze([\n  "fake_code",',
    );
    expect(sabotaged).not.toBe(original);
    expect(diagnostics(sabotaged).length).toBeGreaterThan(0);
  }, 60_000);
});
