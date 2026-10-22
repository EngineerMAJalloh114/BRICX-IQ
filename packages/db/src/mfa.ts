// The MFA requirement of a user (P5-05, phase ruling D5, owner condition
// 1, ADR 0066). mfaState(tx, userId) runs app.mfa_state(), a SECURITY
// DEFINER function only bricx_relay may execute, inside the worker's
// withRelayTx(): the user's Keycloak subject and whether any open org or
// project membership, in any org, holds a finance.* key. The worker's MFA
// consumer maps the answer onto the realm role bricx-mfa. The API never
// calls this: it computes mfaRequired from its own org-scoped reads with
// @bricx/permissions' requiresMfa(). The id is checked before any SQL;
// an error never carries a value.
import { sql } from "drizzle-orm";
import type { Tx } from "./tx.js";

export interface MfaState {
  /** The user's Keycloak subject (users.keycloak_sub). */
  readonly keycloakSub: string;
  /** Whether a finance.* key is in the user's effective keys anywhere. */
  readonly required: boolean;
}

export type MfaStateCode = "invalid_user" | "invalid_result";

export class MfaStateError extends Error {
  readonly code: MfaStateCode;

  constructor(code: MfaStateCode) {
    super(`mfa state: ${code}`);
    this.code = code;
  }
}
Object.defineProperty(MfaStateError.prototype, "name", {
  value: "MfaStateError",
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The user's MFA state, or undefined for an unknown user. */
export async function mfaState(
  tx: Tx,
  userId: string,
): Promise<MfaState | undefined> {
  if (typeof userId !== "string" || !UUID.test(userId)) {
    throw new MfaStateError("invalid_user");
  }
  const result = await tx.execute<{ keycloak_sub: unknown; required: unknown }>(
    sql`SELECT keycloak_sub, required FROM app.mfa_state(${userId}::uuid)`,
  );
  if (result.rows.length === 0) return undefined;
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    row === undefined ||
    typeof row.keycloak_sub !== "string" ||
    typeof row.required !== "boolean"
  ) {
    throw new MfaStateError("invalid_result");
  }
  return { keycloakSub: row.keycloak_sub, required: row.required };
}
