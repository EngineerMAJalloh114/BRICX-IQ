// PermissionError carries a code and a fixed message chosen by the code. It
// never holds or prints the input (P3 rule 9) and has no `cause`. Every code
// maps to an i18n key; all of them to errors:forbidden, so a malformed grant
// or record fails closed and tells the user nothing more than a denial
// (ADR 0048 D10). The key type comes from @bricx/i18n's generated map, for
// types only (ruling 8), so a missing key fails the build.
import type { MessageKey } from "@bricx/i18n/keys";

export const PERMISSION_ERROR_CODES = Object.freeze([
  "invalid_grants",
  "too_many_grants",
  "too_many_targets",
  "unknown_permission",
  "scope_not_allowed",
  "invalid_context",
  "invalid_record",
  "invalid_ability",
  "invalid_sod_input",
  "too_many_history",
  "invalid_model",
  // P5-05 (ADR 0066): a key list above its bound (overrides, MFA rule).
  "too_many_keys",
] as const);
export type PermissionErrorCode = (typeof PERMISSION_ERROR_CODES)[number];

/** The key a client shows for a plain denial (can() returned false). */
export const DENIED_KEY = "errors:forbidden" as const satisfies MessageKey;

/** The key for a segregation-of-duties violation. */
export const SOD_VIOLATION_KEY =
  "errors:permission.sod_violation" as const satisfies MessageKey;

export const PERMISSION_ERROR_KEYS = Object.freeze({
  invalid_grants: DENIED_KEY,
  too_many_grants: DENIED_KEY,
  too_many_targets: DENIED_KEY,
  unknown_permission: DENIED_KEY,
  scope_not_allowed: DENIED_KEY,
  invalid_context: DENIED_KEY,
  invalid_record: DENIED_KEY,
  invalid_ability: DENIED_KEY,
  invalid_sod_input: DENIED_KEY,
  too_many_history: DENIED_KEY,
  invalid_model: DENIED_KEY,
  too_many_keys: DENIED_KEY,
} as const satisfies Record<PermissionErrorCode, MessageKey>);

const messages: Readonly<Record<PermissionErrorCode, string>> = {
  invalid_grants: "grants are malformed",
  too_many_grants: "too many grants",
  too_many_targets: "too many project or site ids",
  unknown_permission: "permission is not in the catalogue",
  scope_not_allowed: "scope is not allowed for this permission",
  invalid_context: "context needs an org id and a user id",
  invalid_record: "record lacks the fields this check needs",
  invalid_ability: "ability handle was not built by this package",
  invalid_sod_input: "segregation-of-duties input is malformed",
  too_many_history: "segregation-of-duties history is too long",
  invalid_model: "permission model is inconsistent",
  too_many_keys: "too many catalogue keys",
};

export class PermissionError extends Error {
  readonly code: PermissionErrorCode;
  readonly key: MessageKey;

  constructor(code: PermissionErrorCode) {
    super(messages[code]);
    this.name = "PermissionError";
    this.code = code;
    this.key = PERMISSION_ERROR_KEYS[code];
  }
}
