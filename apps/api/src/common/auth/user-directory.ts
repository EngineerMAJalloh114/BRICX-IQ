// Who a verified token's subject is (P5-02, ADR 0062, ruling D8, owner
// conditions 2 and 3). DatabaseUserDirectory calls app.provision_user()
// through @bricx/db/users inside withTx(), with the context org = the
// token's org_id hint and user = a fresh UUIDv7 candidate id: the first
// request for a sub inserts the users row with the candidate id; later
// ones get the existing id back and, at most once per throttle interval,
// move last_seen_at (USERS_LAST_SEEN_THROTTLE_SECONDS). Ids and time come
// from the injected Clock. No audit row is written (ADR 0062: users is a
// global table and audit rows are org-scoped); the guard logs one
// auth.provisioned line for an insert. The unit suites bind a directory
// without a database (test/support).
import type { Database } from "@bricx/db/database";
import { provisionUser } from "@bricx/db/users";
import {
  type UuidV7Generator,
  createUuidV7Generator,
} from "@bricx/ids/uuid-v7";
import type { Clock } from "../clock.js";

export interface ProvisionedUser {
  readonly userId: string;
  /** True when this call inserted the row. */
  readonly created: boolean;
}

export interface UserDirectory {
  provision(input: {
    readonly subject: string;
    readonly orgId: string;
  }): Promise<ProvisionedUser>;
}

export const USER_DIRECTORY = Symbol("USER_DIRECTORY");

export class DatabaseUserDirectory implements UserDirectory {
  private readonly ids: UuidV7Generator;

  constructor(
    private readonly database: Database,
    private readonly clock: Clock,
    private readonly throttleSeconds: number,
  ) {
    this.ids = createUuidV7Generator({ clock });
  }

  async provision(input: {
    readonly subject: string;
    readonly orgId: string;
  }): Promise<ProvisionedUser> {
    const candidate = this.ids.next();
    const userId = await this.database.withTx(
      { orgId: input.orgId, userId: candidate, projectIds: [] },
      (tx) =>
        provisionUser(tx, {
          sub: input.subject,
          now: new Date(this.clock.now()).toISOString(),
          throttleSeconds: this.throttleSeconds,
        }),
    );
    return { userId, created: userId === candidate };
  }
}
