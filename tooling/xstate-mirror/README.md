# @bricx/xstate-mirror

Private test package (P3-06, ADR 0049): proves that the XState v5 config `@bricx/domain` derives with `toXStateConfig(machine)` behaves exactly like the domain `transition` function, step by step. It is the only place `xstate` is installed until P9-06; `apps/client` must install the same exact version (5.33.2) or amend ADR 0049 in the same PR (a test here fails on any other installed version).

`src/mirror.ts` builds `createMachine(config, { guards })` from the domain machine's config and the same guard functions, and `step(state, event, context)` returns `snapshot.can(event)` and the next value.

Equivalence mapping (ruling 2b):

| `@bricx/domain`                  | XState                                           |
| -------------------------------- | ------------------------------------------------ |
| `ok(target)`                     | `can` is `true`, next value is `target`          |
| `err("illegal_transition")`      | `can` is `false`, value unchanged                |
| `err("guard_rejected")`          | `can` is `false`, value unchanged                |
| `err("guard_failed")` (throwing) | outside the mapping: XState propagates the throw |

`pnpm --filter @bricx/xstate-mirror test` checks the pin, the config shape (states, initial, final, JSON round trip), every state × event (× context) of the fixture machines, 300 fast-check random walks and 200 exhaustive state × event × guard-outcome sweeps over random machines: 132 tests.
