// Domain errors carry a code and a fixed message chosen by the code. They
// never hold or print the input (P3 rule 9) and have no `cause`. Every code
// maps to an i18n key: codes a user can trigger map to errors:domain.<code>,
// programming and malformed-input codes to errors:generic (ADR 0049). The
// key type comes from @bricx/i18n's generated map, for types only (D11), so
// a missing key fails the build.
import type { MessageKey } from "@bricx/i18n/keys";

export const GENERIC_KEY = "errors:generic" as const satisfies MessageKey;

type Assert<T extends true> = T;

// --- Machine -----------------------------------------------------------

export type MachineErrorCode =
  // definition (thrown by defineMachine)
  | "invalid_definition"
  | "invalid_name"
  | "duplicate_name"
  | "unknown_initial"
  | "undeclared_state"
  | "undeclared_event"
  | "undeclared_guard"
  | "unused_guard"
  | "duplicate_transition"
  | "unreachable_state"
  | "dead_end_state"
  | "final_has_transitions"
  | "too_many_states"
  | "too_many_events"
  | "too_many_transitions"
  | "too_many_guards"
  // transition (returned in a Result)
  | "illegal_transition"
  | "guard_rejected"
  | "guard_failed"
  | "unknown_state"
  | "unknown_event"
  | "invalid_input";

export const MACHINE_ERROR_CODES = Object.freeze([
  "invalid_definition",
  "invalid_name",
  "duplicate_name",
  "unknown_initial",
  "undeclared_state",
  "undeclared_event",
  "undeclared_guard",
  "unused_guard",
  "duplicate_transition",
  "unreachable_state",
  "dead_end_state",
  "final_has_transitions",
  "too_many_states",
  "too_many_events",
  "too_many_transitions",
  "too_many_guards",
  "illegal_transition",
  "guard_rejected",
  "guard_failed",
  "unknown_state",
  "unknown_event",
  "invalid_input",
] as const satisfies readonly MachineErrorCode[]);

// Compile-time agreement in both directions (as @bricx/money): the list
// cannot hold a code the union lacks (`satisfies`), and the union cannot gain
// a code the list lacks (these assertions). types-sabotage.test.ts proves it.
export type MachineErrorCodesAgree = Assert<
  [MachineErrorCode] extends [(typeof MACHINE_ERROR_CODES)[number]]
    ? true
    : false
>;

export const MACHINE_ERROR_KEYS = Object.freeze({
  invalid_definition: GENERIC_KEY,
  invalid_name: GENERIC_KEY,
  duplicate_name: GENERIC_KEY,
  unknown_initial: GENERIC_KEY,
  undeclared_state: GENERIC_KEY,
  undeclared_event: GENERIC_KEY,
  undeclared_guard: GENERIC_KEY,
  unused_guard: GENERIC_KEY,
  duplicate_transition: GENERIC_KEY,
  unreachable_state: GENERIC_KEY,
  dead_end_state: GENERIC_KEY,
  final_has_transitions: GENERIC_KEY,
  too_many_states: GENERIC_KEY,
  too_many_events: GENERIC_KEY,
  too_many_transitions: GENERIC_KEY,
  too_many_guards: GENERIC_KEY,
  illegal_transition: "errors:domain.illegal_transition",
  guard_rejected: "errors:domain.guard_rejected",
  guard_failed: GENERIC_KEY,
  unknown_state: GENERIC_KEY,
  unknown_event: GENERIC_KEY,
  invalid_input: GENERIC_KEY,
} as const satisfies Record<MachineErrorCode, MessageKey>);

const machineMessages: Readonly<Record<MachineErrorCode, string>> = {
  invalid_definition:
    "a machine definition needs an id, an initial state, non-empty states and events, final states, transitions and optional guard functions",
  invalid_name:
    "a machine, state, event or guard name is 1 to 64 lowercase letters, digits or underscores, starting with a letter, and not a name of Object.prototype",
  duplicate_name: "a state, event or final state is declared twice",
  unknown_initial: "the initial state is not a declared state",
  undeclared_state: "a transition or final state names an undeclared state",
  undeclared_event: "a transition names an undeclared event",
  undeclared_guard: "a transition names an undeclared guard",
  unused_guard: "a guard is declared but no transition uses it",
  duplicate_transition: "a state has two transitions for one event",
  unreachable_state: "a state cannot be reached from the initial state",
  dead_end_state: "a non-final state has no transition out",
  final_has_transitions: "a final state has a transition out",
  too_many_states: "too many states",
  too_many_events: "too many events",
  too_many_transitions: "too many transitions",
  too_many_guards: "too many guards",
  illegal_transition: "this event is not allowed in the current state",
  guard_rejected: "a guard rejected this transition",
  guard_failed: "a guard threw; the transition is rejected",
  unknown_state: "not a state of this machine",
  unknown_event: "not an event of this machine",
  invalid_input:
    "the machine is not one made by defineMachine, or a name is not a string of at most 64 characters",
};

// --- Quantity, units and regions ------------------------------------------

export type QuantityErrorCode =
  | "invalid_quantity"
  | "quantity_precision"
  | "quantity_out_of_range"
  | "unknown_unit"
  | "incompatible_units"
  | "invalid_scale"
  | "invalid_rounding"
  | "invalid_country"
  | "invalid_slot";

export const QUANTITY_ERROR_CODES = Object.freeze([
  "invalid_quantity",
  "quantity_precision",
  "quantity_out_of_range",
  "unknown_unit",
  "incompatible_units",
  "invalid_scale",
  "invalid_rounding",
  "invalid_country",
  "invalid_slot",
] as const satisfies readonly QuantityErrorCode[]);

export type QuantityErrorCodesAgree = Assert<
  [QuantityErrorCode] extends [(typeof QUANTITY_ERROR_CODES)[number]]
    ? true
    : false
>;

export const QUANTITY_ERROR_KEYS = Object.freeze({
  invalid_quantity: "errors:domain.invalid_quantity",
  quantity_precision: "errors:domain.quantity_precision",
  quantity_out_of_range: "errors:domain.quantity_out_of_range",
  unknown_unit: "errors:domain.unknown_unit",
  incompatible_units: "errors:domain.incompatible_units",
  invalid_scale: GENERIC_KEY,
  invalid_rounding: GENERIC_KEY,
  invalid_country: GENERIC_KEY,
  invalid_slot: GENERIC_KEY,
} as const satisfies Record<QuantityErrorCode, MessageKey>);

const quantityMessages: Readonly<Record<QuantityErrorCode, string>> = {
  invalid_quantity:
    "not a quantity: a Quantity made by @bricx/domain, or a plain decimal string of at most forty characters (optional leading minus, no leading zeros, no exponent, no spaces)",
  quantity_precision: "more than nine fraction digits; nothing is rounded",
  quantity_out_of_range: "more than twelve integer digits",
  unknown_unit: "not a unit code of this package",
  incompatible_units: "the units measure different dimensions",
  invalid_scale: "the scale is an integer from 0 to 9",
  invalid_rounding: "not a Rounding mode",
  invalid_country: "a country code is two uppercase letters",
  invalid_slot: "not a unit slot (length, area, volume, mass, liquid)",
};

// --- Clock -----------------------------------------------------------------

export type ClockErrorCode = "invalid_clock";

export const CLOCK_ERROR_CODES = Object.freeze([
  "invalid_clock",
] as const satisfies readonly ClockErrorCode[]);

export type ClockErrorCodesAgree = Assert<
  [ClockErrorCode] extends [(typeof CLOCK_ERROR_CODES)[number]] ? true : false
>;

export const CLOCK_ERROR_KEYS = Object.freeze({
  invalid_clock: GENERIC_KEY,
} as const satisfies Record<ClockErrorCode, MessageKey>);

const clockMessages: Readonly<Record<ClockErrorCode, string>> = {
  invalid_clock:
    "a clock instant is an integer number of milliseconds from 0 to 2^48 - 1",
};

// --- Classes ---------------------------------------------------------------

export type DomainErrorCode =
  MachineErrorCode | QuantityErrorCode | ClockErrorCode;

export abstract class DomainError extends Error {
  abstract readonly code: DomainErrorCode;
  abstract readonly key: MessageKey;

  /** The code and the key only: no input ever reaches a serialised error. */
  toJSON(): { name: string; code: DomainErrorCode; key: MessageKey } {
    return { name: this.name, code: this.code, key: this.key };
  }
}

export class MachineError extends DomainError {
  readonly code: MachineErrorCode;
  readonly key: MessageKey;

  constructor(code: MachineErrorCode) {
    super(machineMessages[code]);
    this.name = "MachineError";
    this.code = code;
    this.key = MACHINE_ERROR_KEYS[code];
  }
}

export class QuantityError extends DomainError {
  readonly code: QuantityErrorCode;
  readonly key: MessageKey;

  constructor(code: QuantityErrorCode) {
    super(quantityMessages[code]);
    this.name = "QuantityError";
    this.code = code;
    this.key = QUANTITY_ERROR_KEYS[code];
  }
}

export class ClockError extends DomainError {
  readonly code: ClockErrorCode;
  readonly key: MessageKey;

  constructor(code: ClockErrorCode) {
    super(clockMessages[code]);
    this.name = "ClockError";
    this.code = code;
    this.key = CLOCK_ERROR_KEYS[code];
  }
}
