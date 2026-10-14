// Sabotage for the type tests (P3 rule 1, permanent): compiles
// types.test-d.ts with the TypeScript compiler API, first against the real
// sources (no diagnostics), then with the types loosened. Each loosened
// program must report the matching @ts-expect-error as unused (TS2578).
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const pkgDir = path.join(import.meta.dirname, "..");
const typeTest = path.join(pkgDir, "test/types.test-d.ts");
const translateSrc = path.join(pkgDir, "src/translate.ts");
const keysSrc = path.join(pkgDir, "src/generated/keys.ts");
const i18nextTypesSrc = path.join(pkgDir, "src/i18next-types.ts");

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

const lines = readFileSync(typeTest, "utf8").split("\n");
const markerLine = (marker: string) => {
  const index = lines.findIndex((l) => l.includes(`marker:${marker}`));
  if (index === -1) throw new Error(`no marker ${marker}`);
  return index + 1;
};

/** Replaces `from` (which must occur) in `file`. */
function sabotage(file: string, from: string, to: string): Map<string, string> {
  const original = readFileSync(file, "utf8");
  const changed = original.replace(from, to);
  expect(changed).not.toBe(original);
  return new Map([[file, changed]]);
}

const unused = (found: readonly ts.Diagnostic[], marker: string) =>
  found.some((d) => d.code === 2578 && lineOf(d) === markerLine(marker));

describe("type test sabotage", () => {
  it("the real sources compile types.test-d.ts with no diagnostics", () => {
    const found = diagnostics(new Map());
    expect(
      found.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    ).toEqual([]);
  }, 60_000);

  it("an untyped t makes the key and argument expectations unused", () => {
    const found = diagnostics(
      sabotage(
        translateSrc,
        "readonly t: <K extends MessageKey>(\n    key: K,\n    ...args: TranslateArgs<K>\n  ) => string;",
        "readonly t: (key: string, args?: Readonly<Record<string, unknown>>) => string;",
      ),
    );
    for (const marker of [
      "unknown-key",
      "no-namespace",
      "missing-args-object",
      "missing-argument",
      "plural-not-number",
      "no-args-expected",
      "extra-argument",
    ]) {
      expect(unused(found, marker), marker).toBe(true);
    }
  }, 60_000);

  it("a generated key map without welcome_user's argument makes missing-args-object unused", () => {
    const found = diagnostics(
      sabotage(
        keysSrc,
        `"common:welcome_user": { name: "string" },`,
        `"common:welcome_user": {},`,
      ),
    );
    expect(unused(found, "missing-args-object")).toBe(true);
  }, 60_000);

  it("optional arguments make missing-argument and missing-second-argument unused", () => {
    const found = diagnostics(
      sabotage(
        translateSrc,
        "readonly [A in keyof Spec<K>]: ArgValue<Spec<K>[A]>;",
        "readonly [A in keyof Spec<K>]?: ArgValue<Spec<K>[A]>;",
      ),
    );
    expect(unused(found, "missing-argument")).toBe(true);
    expect(unused(found, "missing-second-argument")).toBe(true);
  }, 60_000);

  it("a number kind for a select makes select-not-string unused", () => {
    const found = diagnostics(
      sabotage(
        keysSrc,
        `"construction:site_status": { status: "select" },`,
        `"construction:site_status": { status: "number" },`,
      ),
    );
    expect(unused(found, "select-not-string")).toBe(true);
  }, 60_000);

  it("without the CustomTypeOptions augmentation, i18next.t accepts any key", () => {
    const found = diagnostics(
      sabotage(
        i18nextTypesSrc,
        "interface CustomTypeOptions",
        "interface CustomTypeOptionsDisabled",
      ),
    );
    expect(unused(found, "i18next-unknown-key")).toBe(true);
  }, 60_000);
});
