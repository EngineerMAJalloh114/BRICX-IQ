// User provisioning (P5-02, phase ruling D8, owner conditions 2 and 3,
// ADR 0062). provisionUser(tx, input) runs app.provision_user() inside the
// caller's withTx(), whose context must carry the request's org hint and
// a fresh UUIDv7 candidate as the user id: a new Keycloak subject gets the
// candidate as its id, a known one keeps its id (returned either way) and
// only its last_seen_at moves, at most once per `throttleSeconds`. The
// input is bounded and checked before any SQL; an error never carries a
// value.
import { sql } from "drizzle-orm";
import type { Tx } from "./tx.js";

/** Longest Keycloak subject accepted (the column's CHECK: 1-255). */
export const MAX_SUB_LENGTH = 255;
/** Longest last_seen_at throttle, in seconds (one day). */
export const MAX_THROTTLE_SECONDS = 86_400;

export interface ProvisionInput {
  /** The access token's `sub`. */
  readonly sub: string;
  /** Now, from the injected Clock, as an ISO 8601 UTC timestamp. */
  readonly now: string;
  /** Write last_seen_at again only after this many seconds. */
  readonly throttleSeconds: number;
}

export type UserProvisionCode =
  "invalid_sub" | "invalid_time" | "invalid_throttle" | "no_user";

export class UserProvisionError extends Error {
  readonly code: UserProvisionCode;

  constructor(code: UserProvisionCode) {
    super(`user provisioning: ${code}`);
    this.code = code;
  }
}
Object.defineProperty(UserProvisionError.prototype, "name", {
  value: "UserProvisionError",
});

// Printable, no control characters (Keycloak subjects are UUIDs).
const SUB = /^[\x21-\x7e]+$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function checked(input: ProvisionInput): ProvisionInput {
  const { sub, now, throttleSeconds } = input;
  if (
    typeof sub !== "string" ||
    sub.length === 0 ||
    sub.length > MAX_SUB_LENGTH ||
    !SUB.test(sub)
  ) {
    throw new UserProvisionError("invalid_sub");
  }
  if (typeof now !== "string" || now.length > 32 || !ISO_UTC.test(now)) {
    throw new UserProvisionError("invalid_time");
  }
  if (
    !Number.isInteger(throttleSeconds) ||
    throttleSeconds < 0 ||
    throttleSeconds > MAX_THROTTLE_SECONDS
  ) {
    throw new UserProvisionError("invalid_throttle");
  }
  return { sub, now, throttleSeconds };
}

/** The user's id for `input.sub`, inserting or touching its row. */
export async function provisionUser(
  tx: Tx,
  input: ProvisionInput,
): Promise<string> {
  const { sub, now, throttleSeconds } = checked(input);
  const result = await tx.execute<{ id: unknown }>(
    sql`SELECT app.provision_user(${sub}, ${now}::timestamptz, ${throttleSeconds}::integer)::text AS id`,
  );
  const id = result.rows[0]?.id;
  if (typeof id !== "string" || !UUID.test(id)) {
    throw new UserProvisionError("no_user");
  }
  return id;
}
