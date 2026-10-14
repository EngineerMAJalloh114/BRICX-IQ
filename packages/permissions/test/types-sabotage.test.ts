// Sabotage for the type tests (P3 rule 1, permanent). Compiles
// types.test-d.ts with the TypeScript compiler API: the real sources give no
// diagnostics; each sabotaged copy must make the marked @ts-expect-error
// unused (TS2578) or fail to compile (a missing i18n key).
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const pkgDir = path.join(import.meta.dirname, "..");
const typeTest = path.join(pkgDir, "test/types.test-d.ts");

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
    [typeTest, path.join(pkgDir, "src/errors.ts")],
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
  const changed = original.replace(from, to);
  expect(changed, `${from} not found in ${file}`).not.toBe(original);
  return new Map([[realpathSync(file), changed]]);
}

const unusedAt = (found: readonly ts.Diagnostic[], marker: string) =>
  found.some((d) => d.code === 2578 && lineOf(d) === markerLine(marker));

describe("type test sabotage", () => {
  it("the real sources compile types.test-d.ts with no diagnostics", () => {
    expect(diagnostics(new Map()).map(text)).toEqual([]);
  }, 60_000);

  it.each([
    [
      "can() taking any action string",
      "src/ability.ts",
      "  action: ActionOf<S>,\n  subjectType: S,\n  record: PermissionRecord,",
      "  action: string,\n  subjectType: S,\n  record: PermissionRecord,",
      ["unknown-action", "action-of-other-subject"],
    ],
    [
      "can() with an optional record (ruling 1)",
      "src/ability.ts",
      "  subjectType: S,\n  record: PermissionRecord,\n): boolean {",
      "  subjectType: S,\n  record?: PermissionRecord,\n): boolean {",
      ["missing-record"],
    ],
    [
      "a grant whose permission is any string",
      "src/ability.ts",
      '  | { readonly permission: PermissionName; readonly scope: "org" }',
      '  | { readonly permission: string; readonly scope: "org" }',
      ["unknown-permission"],
    ],
    [
      "project grants with optional ids",
      "src/ability.ts",
      "      readonly projectIds: readonly ProjectId[];",
      "      readonly projectIds?: readonly ProjectId[];",
      ["project-needs-ids"],
    ],
    [
      "project grants taking any id",
      "src/ability.ts",
      "      readonly projectIds: readonly ProjectId[];",
      "      readonly projectIds: readonly string[];",
      ["wrong-brand"],
    ],
    [
      "a context taking a plain string org id",
      "src/ability.ts",
      "  readonly orgId: OrgId;\n  readonly userId: UserId;",
      "  readonly orgId: string;\n  readonly userId: UserId;",
      ["plain-org-id"],
    ],
    [
      "an ability handle exposing can",
      "src/rules.ts",
      '  readonly [abilityBrand]: "Ability";',
      '  readonly [abilityBrand]: "Ability";\n  readonly can: unknown;',
      ["no-raw-can"],
    ],
  ] as const)(
    "%s makes its @ts-expect-error unused",
    (_name, file, from, to, markers) => {
      const found = diagnostics(sabotage(path.join(pkgDir, file), from, to));
      for (const marker of markers) {
        expect(unusedAt(found, marker), marker).toBe(true);
      }
    },
    60_000,
  );

  it("an SoD key that is not in the i18n catalogs fails to compile", () => {
    const found = diagnostics(
      sabotage(
        path.join(pkgDir, "src/errors.ts"),
        '"errors:permission.sod_violation"',
        '"errors:permission.sod_violations"',
      ),
    );
    expect(
      found.some((d) => d.file?.fileName.endsWith("src/errors.ts") === true),
    ).toBe(true);
  }, 60_000);
});
