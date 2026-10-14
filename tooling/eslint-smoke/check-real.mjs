// Proves the @bricx/ids rules on the real workspace layout, not only on the
// fixture copy (P1-03 left this to P3; P3-01, ADR 0041). Lints probe text
// with the repository's own eslint.config.mjs at real paths in packages/ids:
// the source path must report exactly the expected errors, and the test path
// none of them. The import of packages/config resolves to the real package
// on disk. The cross-package proof through pnpm links comes with P3-02,
// the first package that depends on @bricx/ids.
import path from "node:path";
import process from "node:process";
import { ESLint } from "eslint";

const repoRoot = path.resolve(import.meta.dirname, "../..");

const probe = `import { randomUUID } from "node:crypto";
import { version } from "typescript";
import { loadApiConfig } from "../../config/src/api.js";

export const probes = [randomUUID, version, loadApiConfig];
export const now = Date.now();
export const roll = Math.random();
`;

// Lines 4 and 5 (decimal.js, zod) must pass in money source: the allowed
// npm edges of ADR 0045. (@bricx/ids is allowed by policy but money does
// not depend on it, D4; the fixture allowed.ts covers that element edge.)
const moneyProbe = `import { randomUUID } from "node:crypto";
import { version } from "typescript";
import { loadApiConfig } from "../../config/src/api.js";
import Decimal from "decimal.js";
import { z } from "zod";

export const now = Date.now();
export const roll = Math.random();
export const probes = [randomUUID, version, loadApiConfig, Decimal, z];
`;

// Lines 5-7 (i18next, i18next-icu, intl-messageformat) must pass in i18n
// source: the allowed npm edges of ADR 0046. Line 4 reaches @bricx/money.
const i18nProbe = `import { readFileSync } from "node:fs";
import { version } from "typescript";
import { loadApiConfig } from "../../config/src/api.js";
import { fromMinor } from "../../money/src/money.ts";
import i18next from "i18next";
import ICU from "i18next-icu";
import IntlMessageFormat from "intl-messageformat";

export const probes = [readFileSync, version, loadApiConfig, fromMinor, i18next, ICU, IntlMessageFormat];
export const now = Date.now();
export const roll = Math.random();
`;

// Lines 4-6 must pass in validation source: zod, and @bricx/money and
// @bricx/i18n reached through their real pnpm workspace links (the
// validation -> money and validation -> i18n edges of ADR 0047).
const validationProbe = `import { readFileSync } from "node:fs";
import { version } from "typescript";
import { loadApiConfig } from "../../config/src/api.js";
import { z } from "zod";
import { MoneySchema } from "@bricx/money/schema";
import { normalizeLocale } from "@bricx/i18n/locale";

export const probes = [readFileSync, version, loadApiConfig, z, MoneySchema, normalizeLocale];
export const now = Date.now();
export const roll = Math.random();
`;

// Nothing below validation may import it, and money and i18n stay free of
// any edge to each other (ADR 0047), at the real paths.
const upwardProbe = `import { EmailSchema } from "../../validation/src/email.ts";

export const probes = [EmailSchema];
`;
const moneyToI18nProbe = `import { normalizeLocale } from "../../i18n/src/locale.ts";

export const probes = [normalizeLocale];
`;
const i18nToMoneyProbe = `import { fromMinor } from "../../money/src/money.ts";

export const probes = [fromMinor];
`;

/** @typedef {{ line: number, ruleId: string | null, message: string }} Finding */

/** @type {{ file: string, probe?: string, expected: Finding[] }[]} */
const cases = [
  {
    file: "packages/ids/src/uuid-v7.ts",
    expected: [
      {
        line: 1,
        ruleId: "boundaries/dependencies",
        message:
          'module with origin "core" are not allowed in elements of type "ids"',
      },
      {
        line: 2,
        ruleId: "boundaries/dependencies",
        message:
          'module with origin "external" are not allowed in elements of type "ids"',
      },
      {
        line: 3,
        ruleId: "boundaries/dependencies",
        message:
          'Dependencies to elements of type "package" are not allowed in elements of type "ids"',
      },
      {
        line: 6,
        ruleId: "no-restricted-properties",
        message:
          "Domain, id, money, i18n and validation code must not read the real clock",
      },
      {
        line: 7,
        ruleId: "no-restricted-properties",
        message:
          "Domain, id, money, i18n and validation code must not use Math.random",
      },
    ],
  },
  // Tests may use Node, npm modules, the real clock and other packages.
  { file: "packages/ids/test/generator.test.ts", expected: [] },
  // @bricx/money source (P3-02, ADR 0045): the same bans, except that its
  // two npm dependencies resolve through its real node_modules and pass.
  {
    file: "packages/money/src/money.ts",
    probe: moneyProbe,
    expected: [
      {
        line: 1,
        ruleId: "boundaries/dependencies",
        message:
          'module with origin "core" are not allowed in elements of type "money"',
      },
      {
        line: 2,
        ruleId: "boundaries/dependencies",
        message:
          'module with origin "external" are not allowed in elements of type "money"',
      },
      {
        line: 3,
        ruleId: "boundaries/dependencies",
        message:
          'Dependencies to elements of type "package" and captured values: pkg="config" are not allowed in elements of type "money"',
      },
      {
        line: 7,
        ruleId: "no-restricted-properties",
        message:
          "Domain, id, money, i18n and validation code must not read the real clock",
      },
      {
        line: 8,
        ruleId: "no-restricted-properties",
        message:
          "Domain, id, money, i18n and validation code must not use Math.random",
      },
    ],
  },
  {
    file: "packages/money/test/money.test.ts",
    probe: moneyProbe,
    expected: [],
  },
  // @bricx/i18n source (P3-03, ADR 0046): the same bans; its three npm
  // dependencies (lines 5-7) resolve through its real node_modules and
  // pass, @bricx/money (line 4) does not: i18n depends on nothing above it.
  {
    file: "packages/i18n/src/translate.ts",
    probe: i18nProbe,
    expected: [
      {
        line: 1,
        ruleId: "boundaries/dependencies",
        message:
          'module with origin "core" are not allowed in elements of type "i18n"',
      },
      {
        line: 2,
        ruleId: "boundaries/dependencies",
        message:
          'module with origin "external" are not allowed in elements of type "i18n"',
      },
      {
        line: 3,
        ruleId: "boundaries/dependencies",
        message:
          'Dependencies to elements of type "package" and captured values: pkg="config" are not allowed in elements of type "i18n"',
      },
      {
        line: 4,
        ruleId: "boundaries/dependencies",
        message:
          'Dependencies to elements of type "money" are not allowed in elements of type "i18n"',
      },
      {
        line: 10,
        ruleId: "no-restricted-properties",
        message:
          "Domain, id, money, i18n and validation code must not read the real clock",
      },
      {
        line: 11,
        ruleId: "no-restricted-properties",
        message:
          "Domain, id, money, i18n and validation code must not use Math.random",
      },
    ],
  },
  {
    file: "packages/i18n/test/translate.test.ts",
    probe: i18nProbe,
    expected: [],
  },
  // @bricx/validation source (P3-04, ADR 0047): the same bans; zod and the
  // money and i18n workspace links (lines 4-6) pass.
  {
    file: "packages/validation/src/email.ts",
    probe: validationProbe,
    expected: [
      {
        line: 1,
        ruleId: "boundaries/dependencies",
        message:
          'module with origin "core" are not allowed in elements of type "validation"',
      },
      {
        line: 2,
        ruleId: "boundaries/dependencies",
        message:
          'module with origin "external" are not allowed in elements of type "validation"',
      },
      {
        line: 3,
        ruleId: "boundaries/dependencies",
        message:
          'Dependencies to elements of type "package" and captured values: pkg="config" are not allowed in elements of type "validation"',
      },
      {
        line: 9,
        ruleId: "no-restricted-properties",
        message:
          "Domain, id, money, i18n and validation code must not read the real clock",
      },
      {
        line: 10,
        ruleId: "no-restricted-properties",
        message:
          "Domain, id, money, i18n and validation code must not use Math.random",
      },
    ],
  },
  {
    file: "packages/validation/test/email.test.ts",
    probe: validationProbe,
    expected: [],
  },
  ...["ids/src/uuid-v7.ts", "money/src/money.ts", "i18n/src/translate.ts"].map(
    (file) => ({
      file: `packages/${file}`,
      probe: upwardProbe,
      expected: [
        {
          line: 1,
          ruleId: "boundaries/dependencies",
          message: `Dependencies to elements of type "validation" are not allowed in elements of type "${file.split("/")[0] ?? ""}"`,
        },
      ],
    }),
  ),
  {
    file: "packages/money/src/money.ts",
    probe: moneyToI18nProbe,
    expected: [
      {
        line: 1,
        ruleId: "boundaries/dependencies",
        message:
          'Dependencies to elements of type "i18n" are not allowed in elements of type "money"',
      },
    ],
  },
  {
    file: "packages/i18n/src/translate.ts",
    probe: i18nToMoneyProbe,
    expected: [
      {
        line: 1,
        ruleId: "boundaries/dependencies",
        message:
          'Dependencies to elements of type "money" are not allowed in elements of type "i18n"',
      },
    ],
  },
];

const eslint = new ESLint({ cwd: repoRoot });
/** @type {string[]} */
const problems = [];

for (const { file, probe: text = probe, expected } of cases) {
  const [result] = await eslint.lintText(text, {
    filePath: path.join(repoRoot, file),
  });
  /** @type {Finding[]} */
  const actual = (result?.messages ?? []).map((m) => ({
    line: m.line,
    ruleId: m.ruleId,
    message: m.message,
  }));
  if (result === undefined) problems.push(`${file}: no lint result`);
  for (const e of expected) {
    const index = actual.findIndex(
      (a) =>
        a.line === e.line &&
        a.ruleId === e.ruleId &&
        a.message.includes(e.message),
    );
    if (index === -1) {
      problems.push(
        `MISSING  ${file}:${String(e.line)} ${e.ruleId ?? ""} "${e.message}"`,
      );
      continue;
    }
    actual.splice(index, 1);
    console.log(`ok  ${file}:${String(e.line)}  ${e.ruleId ?? ""}`);
  }
  for (const a of actual) {
    problems.push(
      `UNEXPECTED  ${file}:${String(a.line)} ${a.ruleId ?? "(fatal)"} ${a.message}`,
    );
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  console.error(
    `\neslint-smoke real-workspace check FAILED: ${String(problems.length)} problem(s)`,
  );
  process.exit(1);
}
console.log(
  "eslint-smoke real-workspace check passed: the ids, money, i18n and validation rules fire at the real src paths and not in their tests; nothing below validation imports it and money and i18n do not import each other",
);
