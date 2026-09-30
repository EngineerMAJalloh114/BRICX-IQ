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

const MONEY_NAME = "/amount|price|total/i";
const MONEY_MESSAGE =
  "Do not parse money with parseFloat/parseInt/Number: use @bricx/money (bigint minor units).";
const CLOCK_MESSAGE =
  "Domain code must not read the real clock: use the injected Clock.";

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
                from: { element: { types: ["package", "domain"] } },
                disallow: { to: { element: { types: ["app", "api-module"] } } },
              },
              // packages/domain imports nothing but @bricx/ids and @bricx/money:
              // no other package, npm module or Node built-in.
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
                    { module: { origin: ["external", "core"] } },
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
      files: DOMAIN_FILES,
      rules: {
        "no-restricted-syntax": ["error", ...moneyParsing, ...newDateNow],
        "no-restricted-properties": [
          "error",
          { object: "Date", property: "now", message: CLOCK_MESSAGE },
        ],
      },
    },
    { ...prettier, name: "bricx/prettier" },
  ];
}
