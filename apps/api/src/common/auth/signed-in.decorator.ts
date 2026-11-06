// @SignedIn() (P6-02, ADR 0072; task decision D11, owner condition C1):
// the one kind of route a signed-in user may call before belonging to any
// organisation (POST /v1/organizations). A new user's token carries no
// org_id claim (an attribute only an administrator sets), so the AuthGuard
// verifies the token and provisions the user with no org, then stops: no
// org claim or header is read, and no grants, revocation or session check
// runs (ADR 0072 records the accepted window: a revoked Keycloak session
// keeps such a route until its access token expires, at most 5 minutes).
// The handler reads the user through signedInUser(); there is no identity,
// so TxRunner.run() refuses and only TxRunner.runSignedIn() opens a
// transaction. Handler-level only, and an OpenAPI extension, so
// test/auth-routes.test.ts pins the set of such operations.
import { isUuidV7 } from "@bricx/ids/uuid-v7";
import { SetMetadata, applyDecorators } from "@nestjs/common";
import { ApiExtension } from "@nestjs/swagger";
import { requestSlot, setRequestSlot } from "../db/request-context.js";

/** The metadata key the guards read (the handler only). */
export const SIGNED_IN = "bricx:signed-in";
/** The OpenAPI extension on such an operation. */
export const SIGNED_IN_EXTENSION = "x-bricx-signed-in";

export const SignedIn = () =>
  applyDecorators(
    SetMetadata(SIGNED_IN, true),
    ApiExtension(SIGNED_IN_EXTENSION, true),
  );

/** Who a @SignedIn() request acts as: the users row and the token's acr. */
export interface SignedInUser {
  readonly userId: string;
  readonly acr: "mfa" | "pwd";
}

const SIGNED_IN_SLOT = Symbol("bricx:signed-in-user");

/** Thrown when the value is not a users id and an acr (never expected). */
export class InvalidSignedInUserError extends Error {
  constructor() {
    super("invalid signed-in user");
  }
}
Object.defineProperty(InvalidSignedInUserError.prototype, "name", {
  value: "InvalidSignedInUserError",
});

/** Keeps the signed-in user for the rest of the request (the AuthGuard). */
export function setSignedInUser(user: SignedInUser): void {
  // Checked at run time as well: the value comes from a token.
  const acr: unknown = user.acr;
  if (!isUuidV7(user.userId) || (acr !== "mfa" && acr !== "pwd")) {
    throw new InvalidSignedInUserError();
  }
  setRequestSlot(
    SIGNED_IN_SLOT,
    Object.freeze({ userId: user.userId, acr: user.acr }),
  );
}

/** The signed-in user of a @SignedIn() request, else undefined. */
export function signedInUser(): SignedInUser | undefined {
  // The slot is written by setSignedInUser alone, with this shape.
  return requestSlot(SIGNED_IN_SLOT) as SignedInUser | undefined;
}
