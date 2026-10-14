// Compile-time guarantees (P3 rule 2; plan "compiler sabotages"). Checked by
// `tsc --noEmit` (this package's typecheck) and by types-sabotage.test.ts,
// which breaks the sources and requires each marked @ts-expect-error to
// become unused, or the sources to stop compiling.
import type { IdClock } from "@bricx/ids/uuid-v7";
import { Rounding } from "@bricx/money/rounding";
import { fixedClock } from "../src/clock.ts";
import type { Clock } from "../src/clock.ts";
import { defineMachine, transition } from "../src/machine.ts";
import { err, ok } from "../src/result.ts";
import type { Result } from "../src/result.ts";
import { convert, parseQuantity, quantity } from "../src/units.ts";
import type { Quantity } from "../src/units.ts";
import { projectMachine } from "./helpers.ts";

// A domain Clock is an @bricx/ids IdClock, and the other way round.
export const asIdClock: IdClock = fixedClock(0) satisfies Clock;
export const fromIdClock: Clock = { now: () => 0 } satisfies IdClock;

// A declared event compiles; an undeclared one does not.
export const legal = transition(projectMachine, "draft", "activate", undefined);
// @ts-expect-error marker:undeclared-event -- "fly" is not an event of the machine
transition(projectMachine, "draft", "fly", undefined);
// @ts-expect-error marker:undeclared-state -- "deleted" is not a state of the machine
transition(projectMachine, "deleted", "activate", undefined);

// A transition to an undeclared state does not compile.
defineMachine({
  id: "typo",
  initial: "a",
  states: ["a", "b"],
  events: ["go"],
  final: ["b"],
  // @ts-expect-error marker:undeclared-target -- "z" is not a declared state
  transitions: [{ from: "a", event: "go", to: "z" }],
});

// A Quantity is never built from a number.
export const fromBigint = quantity(125n, 1, "m");
// @ts-expect-error marker:quantity-number -- a coefficient is a bigint, never a number
quantity(12.5, 1, "m");
// @ts-expect-error marker:parse-number -- a quantity value is a string, never a number
parseQuantity(12.5, "m");
// @ts-expect-error marker:quantity-literal -- a Quantity comes only from this package
export const forged: Quantity = { coefficient: 1n, scale: 0, unit: "m" };

// convert needs an explicit rounding (D2).
declare const metre: Quantity;
export const converted = convert(metre, "ft", {
  scale: 2,
  rounding: Rounding.HALF_EVEN,
});
// @ts-expect-error marker:convert-no-rounding -- rounding has no default
convert(metre, "ft", { scale: 2 });

// A Result must be narrowed before its value is read.
const result = ok(1) as Result<number, string>;
// @ts-expect-error marker:result-unnarrowed -- value exists only on the ok branch
export const unnarrowed: number = result.value; // eslint-disable-line @typescript-eslint/no-unsafe-assignment -- the error-typed read is the point
export const narrowed: number = result.ok ? result.value : 0;
export const failed: Result<number, string> = err("no");
