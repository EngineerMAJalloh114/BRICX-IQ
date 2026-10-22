// Roles' outbox events (P5-05, ADR 0066, phase ruling D5; CLAUDE.md rule
// 5): users.mfa_check, one per member of a role whose edit moved a
// finance.* key, written in the editing transaction under the request's
// org; the worker's MFA consumer reads the truth back through
// app.mfa_state() and maps the realm role bricx-mfa. Ids only.
export const USERS_MFA_CHECK = "users.mfa_check";

export interface UsersMfaCheck {
  readonly userId: string;
}
