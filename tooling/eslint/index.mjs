// @bricx/eslint-config: the one ESLint flat config for BRICX IQ.
// Rules come from docs/ROADMAP.md P1-03 and CLAUDE.md; every rule below has a
// violation fixture and an allowed control in tooling/eslint-smoke.
import path from "node:path";
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import boundariesModule from "eslint-plugin-boundaries";
import tseslint from "typescript-eslint";

// eslint-plugin-boundaries is CommonJS but its types declare an ES default
// export, so under NodeNext TypeScript sees the namespace. At run time the
// default import is the plugin itself.
const boundaries = /** @type {import("eslint").ESLint.Plugin} */ (
  /** @type {unknown} */ (boundariesModule)
);

const TS_FILES = ["**/*.{ts,tsx,mts,cts}"];
const JS_FILES = ["**/*.{js,mjs,cjs}"];
const ALL_FILES = [...TS_FILES, ...JS_FILES];
const DOMAIN_FILES = ["packages/domain/**/*.{ts,tsx,mts,cts,js,mjs,cjs}"];
// @bricx/ids library source; its tests may read the real clock and Node APIs.
const IDS_SRC_FILES = ["packages/ids/src/**/*.{ts,tsx,mts,cts,js,mjs,cjs}"];
// @bricx/money library source (P3-02, ADR 0045): same bans as ids.
const MONEY_SRC_FILES = ["packages/money/src/**/*.{ts,tsx,mts,cts,js,mjs,cjs}"];
// @bricx/i18n library source (P3-03, ADR 0046): same bans as ids and money.
const I18N_SRC_FILES = ["packages/i18n/src/**/*.{ts,tsx,mts,cts,js,mjs,cjs}"];

const MONEY_NAME = "/amount|price|total/i";
const MONEY_MESSAGE =
  "Do not parse money with parseFloat/parseInt/Number: use @bricx/money (bigint minor units).";
const CLOCK_MESSAGE =
  "Domain, id, money and i18n code must not read the real clock: time comes in as a parameter (the injected Clock).";
const RANDOM_MESSAGE =
  "Domain, id, money and i18n code must not use Math.random: randomness comes in as a parameter (ids: fillRandom, from globalThis.crypto).";

/** Bans parseFloat/parseInt/Number( on identifiers or properties named like money. */
const moneyParsing = [
  `CallExpression[callee.name=/^(?:parseFloat|parseInt|Number)$/][arguments.0.name=${MONEY_NAME}]`,
  `CallExpression[callee.name=/^(?:parseFloat|parseInt|Number)$/][arguments.0.property.name=${MONEY_NAME}]`,
  `CallExpression[callee.object.name="Number"][callee.property.name=/^(?:parseFloat|parseInt)$/][arguments.0.name=${MONEY_NAME}]`,
  `CallExpression[callee.object.name="Number"][callee.property.name=/^(?:parseFloat|parseInt)$/][arguments.0.property.name=${MONEY_NAME}]`,
].map((selector) => ({ selector, message: MONEY_MESSAGE }));

/** `new Date()` with no arguments reads the clock; `new Date(value)` does not. */
const newDateNow = [
  {
    selector: 'NewExpression[callee.name="Date"][arguments.length=0]',
    message: CLOCK_MESSAGE,
  },
];

/**
 * @param {object} options
 * @param {string} options.rootDir Repository root that boundaries patterns
 *   (apps/*, packages/*) are relative to.
 * @param {string} [options.tsconfigRootDir] Root for the TypeScript project
 *   service; defaults to rootDir.
 * @param {string[]} [options.tsconfigs] tsconfig files the import resolver
 *   reads; defaults to every workspace package's tsconfig.json.
 * @param {string[]} [options.ignores] Extra global ignore patterns.
 * @returns {import("eslint").Linter.Config[]}
 */
export function bricxConfig({
  rootDir,
  tsconfigRootDir = rootDir,
  tsconfigs,
  ignores = [],
}) {
  const resolverProjects = tsconfigs ?? [
    path.join(rootDir, "{apps,packages,tooling}/*/tsconfig.json"),
  ];

  return [
    {
      name: "bricx/ignores",
      ignores: [
        "**/dist/**",
        "**/build/**",
        "**/coverage/**",
        "**/.turbo/**",
        "**/.expo/**",
        ...ignores,
      ],
    },
    {
      name: "bricx/linter-options",
      linterOptions: { reportUnusedDisableDirectives: "error" },
    },
    {
      ...js.configs.recommended,
      name: "bricx/eslint-recommended",
      files: ALL_FILES,
    },
    ...tseslint.configs.strictTypeChecked.map((config) => ({
      ...config,
      files: ALL_FILES,
    })),
    {
      name: "bricx/type-information",
      files: ALL_FILES,
      languageOptions: {
        parserOptions: { projectService: true, tsconfigRootDir },
      },
    },
    {
      // TypeScript (checkJs) reports undefined names in JS files too.
      name: "bricx/js-files",
      files: JS_FILES,
      rules: { "no-undef": "off" },
    },
    {
      name: "bricx/boundaries",
      files: ALL_FILES,
      plugins: { boundaries },
      settings: {
        "boundaries/root-path": rootDir,
        "import/resolver": {
          typescript: { alwaysTryTypes: true, project: resolverProjects },
        },
        "boundaries/elements": [
          {
            type: "api-module",
            pattern: "apps/api/src/modules/*",
            capture: ["module"],
          },
          { type: "app", pattern: "apps/*", capture: ["app"] },
          { type: "domain", pattern: "packages/domain" },
          // @bricx/ids source only (P3-01, ADR 0041); its tests are "package".
          // partialMatch: false anchors the pattern at the root, so fixture copies nested
          // elsewhere (tooling/vitest-smoke/fixtures/*/packages/ids) are not ids.
          { type: "ids", pattern: "packages/ids/src/**", partialMatch: false },
          // @bricx/money source only (P3-02, ADR 0045); its tests, data and
          // scripts are "package". Anchored for the same reason as ids.
          {
            type: "money",
            pattern: "packages/money/src/**",
            partialMatch: false,
          },
          // @bricx/i18n source only (P3-03, ADR 0046); its tests, locales,
          // glossary and scripts are "package". Anchored as ids and money.
          {
            type: "i18n",
            pattern: "packages/i18n/src/**",
            partialMatch: false,
          },
          { type: "package", pattern: "packages/*", capture: ["pkg"] },
        ],
      },
      rules: {
        "boundaries/dependencies": [
          "error",
          {
            default: "allow",
            checkAllOrigins: true,
            policies: [
              // packages/* never import apps/*.
              {
                from: {
                  element: {
                    types: ["package", "domain", "ids", "money", "i18n"],
                  },
                },
                disallow: { to: { element: { types: ["app", "api-module"] } } },
              },
              // packages/domain imports nothing but @bricx/ids and @bricx/money:
              // no other package (i18n included), npm module or Node built-in.
              {
                from: { element: { type: "domain" } },
                disallow: {
                  to: [
                    {
                      element: {
                        type: "package",
                        captured: { pkg: "!{ids,money}" },
                      },
                    },
                    { element: { type: "i18n" } },
                    { module: { origin: ["external", "core"] } },
                  ],
                },
              },
              // @bricx/ids is the bottom of the dependency graph
              // (ids <- money <- validation): its source imports no other
              // workspace package, no npm module and no Node built-in, so it
              // runs on devices too (P3-01, ADR 0041).
              {
                from: { element: { type: "ids" } },
                disallow: {
                  to: [
                    {
                      element: {
                        types: [
                          "package",
                          "domain",
                          "money",
                          "i18n",
                          "app",
                          "api-module",
                        ],
                      },
                    },
                    { module: { origin: ["external", "core"] } },
                  ],
                },
              },
              // @bricx/money sits above ids (ids <- money <- validation): its
              // source may import @bricx/ids, its own data/ (the generated
              // ISO 4217 file, a "package" element with pkg=money), decimal.js
              // and zod, and nothing else: no other workspace package, no other
              // npm module, no Node built-in, so it runs on devices too
              // (P3-02, ADR 0045).
              {
                from: { element: { type: "money" } },
                disallow: {
                  to: [
                    {
                      element: {
                        type: "package",
                        captured: { pkg: "!money" },
                      },
                    },
                    {
                      element: {
                        types: ["domain", "i18n", "app", "api-module"],
                      },
                    },
                    { module: { origin: "core" } },
                    {
                      module: {
                        origin: "external",
                        source: "!{decimal.js,zod}",
                      },
                    },
                  ],
                },
              },
              // @bricx/i18n depends on nothing above it (P3 rule 4): its
              // source may import its own files, its locales/ (a "package"
              // element with pkg=i18n), i18next, i18next-icu and
              // intl-messageformat, and nothing else: no other workspace
              // package (ids and money included), no other npm module, no
              // Node built-in, so it runs on devices too (P3-03, ADR 0046).
              {
                from: { element: { type: "i18n" } },
                disallow: {
                  to: [
                    {
                      element: {
                        type: "package",
                        captured: { pkg: "!i18n" },
                      },
                    },
                    {
                      element: {
                        types: ["domain", "ids", "money", "app", "api-module"],
                      },
                    },
                    { module: { origin: "core" } },
                    {
                      module: {
                        origin: "external",
                        source: "!{i18next,i18next-icu,intl-messageformat}",
                      },
                    },
                  ],
                },
              },
              // An api module imports another module only via its public-api.ts.
              {
                from: { element: { type: "api-module" } },
                disallow: {
                  to: {
                    element: {
                      type: "api-module",
                      fileInternalPath: "!public-api.ts",
                      captured: {
                        module: "!{{ from.element.captured.module }}",
                      },
                    },
                  },
                },
              },
            ],
          },
        ],
      },
    },
    {
      name: "bricx/money-parsing",
      files: ALL_FILES,
      rules: { "no-restricted-syntax": ["error", ...moneyParsing] },
    },
    {
      // Repeats the money selectors: a later no-restricted-syntax replaces,
      // not merges, the earlier one.
      name: "bricx/domain-clock",
      files: [
        ...DOMAIN_FILES,
        ...IDS_SRC_FILES,
        ...MONEY_SRC_FILES,
        ...I18N_SRC_FILES,
      ],
      rules: {
        "no-restricted-syntax": ["error", ...moneyParsing, ...newDateNow],
        "no-restricted-properties": [
          "error",
          { object: "Date", property: "now", message: CLOCK_MESSAGE },
          { object: "Math", property: "random", message: RANDOM_MESSAGE },
        ],
      },
    },
    { ...prettier, name: "bricx/prettier" },
  ];
}
