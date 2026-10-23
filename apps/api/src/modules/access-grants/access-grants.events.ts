// Access grants' outbox events (P5-06, ADR 0067; CLAUDE.md rule 5):
// access_grants.expire, one per grant, written in the granting
// transaction with not_before = expires_at, so the relay publishes it as
// a BullMQ delayed job due at the grant's end; the worker's consumer then
// records expired_at, audits org.access_grant.expire and re-checks MFA.
// The grant's end is effective in the API at the instant whatever the
// job does (DbGrantsSource reads active rows at the Clock). Ids only.
export const ACCESS_GRANTS_EXPIRE = "access_grants.expire";

export interface AccessGrantsExpire {
  readonly grantId: string;
  readonly userId: string;
}
