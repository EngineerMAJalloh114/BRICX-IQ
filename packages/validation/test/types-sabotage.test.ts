// Sabotage for the type tests and the money drift check (P3 rule 1,
// permanent). Compiles types.test-d.ts with the TypeScript compiler API:
// the real sources give no diagnostics; each sabotaged copy must produce the
// expected error (an unused @ts-expect-error, TS2578, or a missing key).
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const pkgDir = path.join(import.meta.dirname, "..");
const typeTest = path.join(pkgDir, "test/types.test-d.ts");
const moneyErrors = path.join(
  realpathSync(path.join(pkgDir, "node_modules/@bricx/money")),
  "src/errors.ts",
);

function diagnostics(
  overrides: ReadonlyMap<string, string>,
): readonly ts.Diagnostic[] {
  const configPath = path.join(pkgDir, "tsconfig.json");
  const config = ts.readConfigFile(configPath, (f) => ts.sys.readFile(f));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, pkgDir);
  const host = ts.createCompilerHost(parsed.options);
  const real = (file: string) => {
    try {
      return realpathSync(file);
    } catch {
      return path.resolve(file);
    }
  };
  const readFile = host.readFile.bind(host);
  host.readFile = (file) => overrides.get(real(file)) ?? readFile(file);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, lang, onError) => {
    const text = overrides.get(real(file));
    return text === undefined
      ? getSourceFile(file, lang, onError)
      : ts.createSourceFile(file, text, lang);
  };
  const program = ts.createProgram([typeTest], parsed.options, host);
  return ts.getPreEmitDiagnostics(program);
}

const text = (d: ts.Diagnostic) =>
  ts.flattenDiagnosticMessageText(d.messageText, "\n");
const lineOf = (d: ts.Diagnostic) =>
  d.file === undefined || d.start === undefined
    ? -1
    : d.file.getLineAndCharacterOfPosition(d.start).line + 1;
const typeTestLines = readFileSync(typeTest, "utf8").split("\n");
const lineAfter = (marker: string) =>
  typeTestLines.findIndex((l) => l.includes(marker)) + 1;

function sabotage(file: string, from: string, to: string): Map<string, string> {
  const original = readFileSync(file, "utf8");
  const changed = original.replace(from, to);
  expect(changed, `${from} not found in ${file}`).not.toBe(original);
  return new Map([[realpathSync(file), changed]]);
}

describe("type test sabotage", () => {
  it("the real sources compile types.test-d.ts with no diagnostics", () => {
    expect(diagnostics(new Map()).map(text)).toEqual([]);
  }, 60_000);

  it("an unbranded EmailSchema makes the raw-string @ts-expect-error unused", () => {
    const found = diagnostics(
      sabotage(path.join(pkgDir, "src/email.ts"), '.brand<"Email">()', ""),
    );
    expect(
      found.some(
        (d) => d.code === 2578 && lineOf(d) === lineAfter("not an Email"),
      ),
    ).toBe(true);
  }, 60_000);

  it("an unbranded PhoneE164Schema makes the raw-string @ts-expect-error unused", () => {
    const found = diagnostics(
      sabotage(path.join(pkgDir, "src/phone.ts"), '.brand<"PhoneE164">()', ""),
    );
    expect(
      found.some(
        (d) => d.code === 2578 && lineOf(d) === lineAfter("not a PhoneE164"),
      ),
    ).toBe(true);
  }, 60_000);

  // The compile-time half of the money drift check: a new MoneyError code
  // without an errors:money.<code> key fails the build of src/codes.ts.
  it("a MoneyError code added in @bricx/money without a key fails to compile", () => {
    const original = readFileSync(moneyErrors, "utf8");
    const changed = original
      .replace(
        '  | "invalid_locale";',
        '  | "invalid_locale"\n  | "fake_code";',
      )
      .replace(
        "export const MONEY_ERROR_CODES = Object.freeze([",
        'export const MONEY_ERROR_CODES = Object.freeze([\n  "fake_code",',
      );
    expect(changed).not.toBe(original);
    const found = diagnostics(new Map([[realpathSync(moneyErrors), changed]]));
    const inCodes = found.filter(
      (d) => d.file?.fileName.endsWith("src/codes.ts") === true,
    );
    expect(inCodes.map(text).join("\n")).toMatch(/fake_code/);
  }, 60_000);
});
