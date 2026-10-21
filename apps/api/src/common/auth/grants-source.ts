// Where an identity's projects and grants come from (P5-02, ADR 0062,
// owner condition 1). The auth guard asks once per request, after the
// token is verified and the user provisioned. P5-05 binds a source that
// reads the user's memberships in the org; until then production binds
// noGrants: no projects, no grants, so every policy denies. Tests bind
// their own source through createApp's test-only option (test/support);
// src never maps role names to grants.
import type { Grant } from "@bricx/permissions/ability";

export interface Access {
  readonly projectIds: readonly string[];
  readonly grants: readonly Grant[];
}

export interface GrantsSource {
  grantsFor(user: {
    readonly userId: string;
    readonly orgId: string;
  }): Promise<Access>;
}

export const GRANTS_SOURCE = Symbol("GRANTS_SOURCE");

/** Production until P5-05: nothing is granted. */
export const noGrants: GrantsSource = Object.freeze({
  grantsFor: () => Promise.resolve({ projectIds: [], grants: [] }),
});
