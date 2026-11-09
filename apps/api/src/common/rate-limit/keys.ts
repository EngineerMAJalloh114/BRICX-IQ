// Rate-limit keys (P6-05d, ADR 0080): rl:v1:<class>:<dim>:<id>. The id
// is a user or org UUID, or the first 32 hex of SHA-256 of the client
// address, IPv6 by its /64 (@nestjs/throttler's normalizeIp). Never a
// token, a sid, an e-mail or an address. The hash is unsalted (owner
// ruling C6: a residual, recorded in the ADR): a key lives at most one
// window.
import { createHash } from "node:crypto";
import type {
  RateLimitClass,
  RateLimitDimension,
} from "@bricx/config/rate-limits";
import { normalizeIp } from "@nestjs/throttler";

export const RATE_LIMIT_KEY_PREFIX = "rl:v1:";
const IPV6_PREFIX_BITS = 64;

export function rateLimitKey(
  cls: RateLimitClass,
  dim: RateLimitDimension,
  id: string,
): string {
  return `${RATE_LIMIT_KEY_PREFIX}${cls}:${dim}:${id}`;
}

/** The key id of a client address. */
export function ipKeyId(ip: string): string {
  return createHash("sha256")
    .update(normalizeIp(ip, IPV6_PREFIX_BITS))
    .digest("hex")
    .slice(0, 32);
}
