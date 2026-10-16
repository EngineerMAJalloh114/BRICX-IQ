// The request fingerprint (P4-07, ADR 0057, decision 6a): SHA-256 over
// RFC 8785 canonical JSON (the canonicalize package, ADR 0017) of
// { body, query }, so key order never matters and a changed value, a
// changed query or a body moved to the query always does. A request
// without a body hashes `null`.
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

export interface FingerprintInput {
  readonly query: unknown;
  readonly body: unknown;
}

export function requestFingerprint(input: FingerprintInput): Buffer {
  const text = canonicalize({ body: input.body ?? null, query: input.query });
  return createHash("sha256")
    .update(text ?? "null", "utf8")
    .digest();
}

/** "METHOD /path": the method upper-cased, the path without query or fragment. */
export function idempotencyRoute(method: string, url: string): string {
  const end = url.search(/[?#]/);
  return `${method.toUpperCase()} ${end === -1 ? url : url.slice(0, end)}`;
}
