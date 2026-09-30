# @bricx/eslint-config

The one ESLint flat config for BRICX IQ. The root `eslint.config.mjs` calls
`bricxConfig({ rootDir })`; every workspace package runs `eslint . --max-warnings 0`
from its `lint` script and picks up that root file.

| Block                                   | What it enforces                                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@eslint/js` recommended                | ESLint core rules on TS and JS/.mjs files                                                                                                                                                                                |
| typescript-eslint `strict-type-checked` | Strict, type-aware rules; JS files are type-checked through `checkJs`                                                                                                                                                    |
| `boundaries/dependencies`               | `packages/*` never import `apps/*`; `packages/domain` imports only `@bricx/ids` and `@bricx/money` (no other package, npm module or `node:` built-in); an api module imports another module only via its `public-api.ts` |
| `no-restricted-syntax` (money)          | No `parseFloat`, `parseInt`, `Number`, `Number.parseFloat` or `Number.parseInt` on an identifier or property matching `/amount\|price\|total/i`                                                                          |
| Domain clock                            | In `packages/domain`: no `Date.now()` and no zero-argument `new Date()`; use the injected `Clock`                                                                                                                        |
| `eslint-config-prettier`                | Turns off rules that fight Prettier                                                                                                                                                                                      |
| Linter options                          | Unused `eslint-disable` comments are errors                                                                                                                                                                              |

Every rule has a violation fixture and an allowed control in
[`tooling/eslint-smoke`](../eslint-smoke/README.md).

Turbo lint inputs include `tooling/eslint/*.{mjs,json}`, so changing a rule or
a plugin version invalidates every package's lint cache.
