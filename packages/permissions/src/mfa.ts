// The MFA rule (P5-05, phase ruling D5, ADR 0066): a user whose effective
// keys hold any finance.* key must hold the Keycloak realm role bricx-mfa
// (ADR 0060). The API computes it from its org-scoped reads; the worker's
// MFA consumer reads the same rule in SQL (app.mfa_state(), packages/db).
import { CATALOGUE } from "./catalogue.ts";
import { PermissionError } from "./errors.ts";

/** The catalogue module whose keys require MFA, as a key prefix. */
export const MFA_KEY_PREFIX = "finance.";

/** Whether `keys` (catalogue keys) require MFA. Bounded by the catalogue. */
export function requiresMfa(keys: readonly string[]): boolean {
  if (!Array.isArray(keys) || keys.length > CATALOGUE.length) {
    throw new PermissionError("too_many_keys");
  }
  return keys.some(
    (key) => typeof key === "string" && key.startsWith(MFA_KEY_PREFIX),
  );
}
