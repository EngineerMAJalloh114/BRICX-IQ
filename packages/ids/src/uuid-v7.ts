// UUIDv7 (RFC 9562 §5.7), written in-house with no dependency (ADR 0041).
//
// Layout of each id:
//   48 bits unix_ts_ms  = the injected clock, bit for bit
//    4 bits version     = 0111
//   12 bits rand_a      = counter bits 41..30
//    2 bits variant     = 10
//   62 bits rand_b      = counter bits 29..0, then 32 fresh random bits
//
// The 42-bit counter is seeded with 41 random bits (top bit clear) at each
// new millisecond and incremented within one, so a generator's ids are
// strictly increasing as bytes and as lowercase strings. Time comes in as
// a parameter (`clock`); randomness from `fillRandom`, by default
// globalThis.crypto.getRandomValues, looked up when an id is made so the
// module loads on any runtime.
import type { Brand } from "./brand.js";
import { IdError } from "./errors.js";
import type { IdErrorCode } from "./errors.js";
import { MAX_COUNTER, MAX_TIMESTAMP, nextState } from "./state.js";
import type { GeneratorState } from "./state.js";

export { IdError } from "./errors.js";
export type { IdErrorCode } from "./errors.js";

/** A lowercase RFC 9562 version 7, variant 10 UUID string. */
export type UuidV7 = Brand<string, "UuidV7">;

/** Milliseconds since the Unix epoch; an integer from 0 to 2^48 - 1. */
export interface IdClock {
  now(): number;
}

/** Fills `bytes` with cryptographically strong random bytes. */
export type FillRandom = (bytes: Uint8Array) => void;

export interface UuidV7GeneratorOptions {
  readonly clock: IdClock;
  readonly fillRandom?: FillRandom;
}

export interface UuidV7Generator {
  next(): UuidV7;
}

export type IdParseErrorCode = Extract<
  IdErrorCode,
  "not_a_string" | "bad_format" | "uppercase" | "not_v7" | "bad_variant"
>;

export type IdParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: IdParseErrorCode };

const RANDOM_BYTES = 10;

const HEX: readonly string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, "0"),
);

const hex = (byte: number): string => HEX[byte & 0xff] ?? "";

function defaultFillRandom(bytes: Uint8Array): void {
  const source: unknown = Reflect.get(globalThis, "crypto");
  if (
    typeof source !== "object" ||
    source === null ||
    !("getRandomValues" in source) ||
    typeof source.getRandomValues !== "function"
  ) {
    throw new IdError("no_crypto");
  }
  Reflect.apply(source.getRandomValues, source, [bytes]);
}

function readClock(clock: IdClock): number {
  const now: unknown = clock.now();
  if (
    typeof now !== "number" ||
    !Number.isInteger(now) ||
    now < 0 ||
    now > MAX_TIMESTAMP
  ) {
    throw new IdError("invalid_clock");
  }
  return now;
}

/** 41 random bits from bytes 0..5: the low bit of byte 0, then bytes 1..5. */
function seedOf(random: Uint8Array): number {
  let seed = (random[0] ?? 0) & 0x01;
  for (let i = 1; i <= 5; i += 1) seed = seed * 256 + (random[i] ?? 0);
  return seed;
}

/** Bits `shift`..`shift + 7` of a non-negative integer below 2^53. */
const byteAt = (value: number, shift: number): number =>
  Math.floor(value / 2 ** shift) % 256;

function format(ms: number, counter: number, random: Uint8Array): UuidV7 {
  const id =
    hex(byteAt(ms, 40)) +
    hex(byteAt(ms, 32)) +
    hex(byteAt(ms, 24)) +
    hex(byteAt(ms, 16)) +
    "-" +
    hex(byteAt(ms, 8)) +
    hex(byteAt(ms, 0)) +
    "-" +
    hex(0x70 | (byteAt(counter, 38) & 0x0f)) +
    hex(byteAt(counter, 30)) +
    "-" +
    hex(0x80 | (byteAt(counter, 24) & 0x3f)) +
    hex(byteAt(counter, 16)) +
    "-" +
    hex(byteAt(counter, 8)) +
    hex(byteAt(counter, 0)) +
    hex(random[6] ?? 0) +
    hex(random[7] ?? 0) +
    hex(random[8] ?? 0) +
    hex(random[9] ?? 0);
  return id as UuidV7;
}

/**
 * Creates a generator whose ids are strictly increasing, also within one
 * millisecond and when the clock goes backwards. Each generator keeps its
 * own state; share one per app instance (or one per seed run).
 */
export function createUuidV7Generator(
  options: UuidV7GeneratorOptions,
): UuidV7Generator {
  const { clock } = options;
  const fillRandom = options.fillRandom ?? defaultFillRandom;
  const random = new Uint8Array(RANDOM_BYTES);
  let state: GeneratorState | undefined;
  return {
    next() {
      const now = readClock(clock);
      fillRandom(random);
      state = nextState(state, now, seedOf(random), MAX_COUNTER);
      return format(state.ms, state.counter, random);
    },
  };
}

const CANONICAL =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const VARIANT_10 = /^[89ab]$/;

/** Why `input` is not a UuidV7, or undefined when it is one. */
function problemOf(input: unknown): IdParseErrorCode | undefined {
  if (typeof input !== "string") return "not_a_string";
  if (!CANONICAL.test(input)) return "bad_format";
  if (input !== input.toLowerCase()) return "uppercase";
  if (input.charAt(14) !== "7") return "not_v7";
  if (!VARIANT_10.test(input.charAt(19))) return "bad_variant";
  return undefined;
}

/**
 * Returns `input` as a UuidV7, or throws IdError. Strict: lowercase only.
 * Callers at an API boundary lowercase untrusted input first (ADR 0041).
 */
export function parseUuidV7(input: unknown): UuidV7 {
  const problem = problemOf(input);
  if (problem !== undefined) throw new IdError(problem);
  return input as UuidV7;
}

export function safeParseUuidV7(input: unknown): IdParseResult<UuidV7> {
  const problem = problemOf(input);
  return problem === undefined
    ? { ok: true, value: input as UuidV7 }
    : { ok: false, code: problem };
}

export function isUuidV7(input: unknown): input is UuidV7 {
  return problemOf(input) === undefined;
}
