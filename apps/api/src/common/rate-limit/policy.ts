// What the limiter does when its store is down, and the numbers it
// answers with (P6-05d, ADR 0080; owner condition C2).
// - default falls back to the in-process store at the same limits (fail
//   open, bounded); the other classes fail closed with 503
//   server_unavailable. A route may name its own mode (C2: GET
//   /v1/directory/resolve falls back, so sign-in routing survives a
//   Valkey outage).
// - Retry-After: the whole seconds left of the window, at least 1; a
//   store-down 503 says 5.
// - One rate_limit.store_unavailable warn line per class and mode at most
//   every 10 s per process.
import type { RateLimitClass } from "@bricx/config/rate-limits";

export type StoreDownMode = "fallback" | "closed";

export const STORE_DOWN_DEFAULTS: Readonly<
  Record<RateLimitClass, StoreDownMode>
> = Object.freeze({
  default: "fallback",
  auth_adjacent: "closed",
  invitation: "closed",
  upload: "closed",
  export: "closed",
});

export const STORE_DOWN_RETRY_AFTER_SECONDS = 5;
export const STORE_DOWN_LOG_INTERVAL_MS = 10_000;

/** The Retry-After value for `secondsLeft` of a window. */
export function retryAfterSeconds(secondsLeft: number): number {
  return Math.max(1, Math.ceil(secondsLeft));
}
