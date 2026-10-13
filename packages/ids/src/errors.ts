// IdError carries a code and a fixed message chosen by the code. It never
// holds or prints the input or the clock value (P3 rule 9), and has no
// `cause`.
export type IdErrorCode =
  | "not_a_string"
  | "bad_format"
  | "uppercase"
  | "not_v7"
  | "bad_variant"
  | "invalid_clock"
  | "timestamp_overflow"
  | "no_crypto";

const messages: Readonly<Record<IdErrorCode, string>> = {
  not_a_string: "not a string",
  bad_format: "not a canonical 8-4-4-4-12 UUID string",
  uppercase: "contains uppercase hex digits; ids are lowercase",
  not_v7: "not a version 7 UUID",
  bad_variant: "not the RFC 9562 variant (10xx)",
  invalid_clock:
    "the clock did not return an integer number of milliseconds from 0 to 2^48 - 1",
  timestamp_overflow: "no 48-bit timestamp is left after the current one",
  no_crypto: "globalThis.crypto.getRandomValues is not available",
};

export class IdError extends Error {
  readonly code: IdErrorCode;

  constructor(code: IdErrorCode) {
    super(`${code}: ${messages[code]}`);
    this.code = code;
  }

  override get name(): string {
    return "IdError";
  }
}
