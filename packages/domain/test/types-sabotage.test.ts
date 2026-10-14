// Sabotage for the type tests (P3 rule 1, permanent). Compiles
// types.test-d.ts with the TypeScript compiler API: the real sources give no
// diagnostics; each sabotaged copy must make the marked @ts-expect-error
// unused (TS2578) or fail to compile (the error code lists).
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const pkgDir = path.join(import.meta.dirname, "..");
const typeTest = path.join(pkgDir, "test/types.test-d.ts");
const src = (file: string) => path.join(pkgDir, "src", file);

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
  const program = ts.createProgram(
    [typeTest, src("errors.ts")],
    parsed.options,
    host,
  );
  return ts.getPreEmitDiagnostics(program);
}

const text = (d: ts.Diagnostic) =>
  ts.flattenDiagnosticMessageText(d.messageText, "\n");
const lineOf = (d: ts.Diagnostic) =>
  d.file === undefined || d.start === undefined
    ? -1
    : d.file.getLineAndCharacterOfPosition(d.start).line + 1;
const typeTestLines = readFileSync(typeTest, "utf8").split("\n");
const markerLine = (marker: string) =>
  typeTestLines.findIndex((l) => l.includes(`marker:${marker}`)) + 1;

function sabotage(file: string, from: string, to: string): Map<string, string> {
  const original = readFileSync(file, "utf8");
  expect(
    original.split(from),
    `${from} must occur once in ${file}`,
  ).toHaveLength(2);
  return new Map([[realpathSync(file), original.replace(from, to)]]);
}

/** The diagnostics at the marker: an unused @ts-expect-error (TS2578). */
function unusedAt(diags: readonly ts.Diagnostic[], marker: string): boolean {
  const line = markerLine(marker);
  expect(line, `marker ${marker}`).toBeGreaterThan(0);
  return diags.some((d) => d.code === 2578 && lineOf(d) === line);
}

// Each case builds a TypeScript program; under a full `pnpm verify` the CPU
// is shared with every other package, so the default 5 s is not enough on
// the CI runner. A generous ceiling, never a timing assertion.
const COMPILER_TIMEOUT = 120_000;

describe(
  "the real sources compile with every expect-error used",
  { timeout: COMPILER_TIMEOUT },
  () => {
    it("no diagnostics", () => {
      expect(diagnostics(new Map()).map(text)).toEqual([]);
    });
  },
);

describe(
  "each compiler sabotage is caught",
  { timeout: COMPILER_TIMEOUT },
  () => {
    it("transition accepting any string as the event", () => {
      const diags = diagnostics(
        sabotage(src("machine.ts"), "event: NoInfer<E>,", "event: string,"),
      );
      expect(unusedAt(diags, "undeclared-event")).toBe(true);
    });

    it("transition accepting any string as the state", () => {
      const diags = diagnostics(
        sabotage(src("machine.ts"), "state: NoInfer<S>,", "state: string,"),
      );
      expect(unusedAt(diags, "undeclared-state")).toBe(true);
    });

    it("quantity accepting a number coefficient", () => {
      const diags = diagnostics(
        sabotage(
          src("units.ts"),
          "export function quantity(\n  coefficient: bigint,",
          "export function quantity(\n  coefficient: bigint | number,",
        ),
      );
      expect(unusedAt(diags, "quantity-number")).toBe(true);
    });

    it("parseQuantity accepting a number", () => {
      const diags = diagnostics(
        sabotage(src("units.ts"), "value: string,", "value: string | number,"),
      );
      expect(unusedAt(diags, "parse-number")).toBe(true);
    });

    it("Quantity without its brand", () => {
      const diags = diagnostics(
        sabotage(src("units.ts"), "readonly [quantityBrand]: true;", ""),
      );
      expect(unusedAt(diags, "quantity-literal")).toBe(true);
    });

    it("convert with a default rounding", () => {
      const diags = diagnostics(
        sabotage(
          src("units.ts"),
          "readonly rounding: Rounding;",
          "readonly rounding?: Rounding;",
        ),
      );
      expect(unusedAt(diags, "convert-no-rounding")).toBe(true);
    });

    it("Result whose error branch also carries a value", () => {
      const diags = diagnostics(
        sabotage(
          src("result.ts"),
          "readonly error: E };",
          "readonly error: E; readonly value: never };",
        ),
      );
      expect(unusedAt(diags, "result-unnarrowed")).toBe(true);
    });

    it.each([
      [
        "MachineErrorCode",
        '| "illegal_transition"',
        '| "illegal_transition"\n  | "sabotage_code"',
      ],
      [
        "QuantityErrorCode",
        '| "incompatible_units"',
        '| "incompatible_units"\n  | "sabotage_code"',
      ],
      [
        "ClockErrorCode",
        '"invalid_clock";',
        '"invalid_clock" | "sabotage_code";',
      ],
    ])(
      "a code in the %s union but not in its list fails to compile",
      (_n, from, to) => {
        const diags = diagnostics(sabotage(src("errors.ts"), from, to));
        expect(
          diags.some((d) => d.file?.fileName.endsWith("src/errors.ts")),
          diags.map(text).join("\n"),
        ).toBe(true);
      },
    );
  },
);
