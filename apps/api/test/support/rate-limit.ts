// Test-only rate-limit stores (P6-05d, ADR 0080), for createApp's
// rateLimitStore option (never set by bootstrap.ts):
// - memoryRateLimits(): the in-process store (the same class the guard
//   falls back to when Valkey is down), so a suite without Valkey keeps
//   the real limits and the real fail-closed classes stay reachable;
// - failingRateLimits(): every increment fails as if Valkey were
//   unreachable (the store-down matrix), counting its calls.
// The Valkey store itself is proved live in rate-limit.int.test.ts.
// src never imports this folder (Semgrep bricx-src-imports-test-support).
import type { ThrottlerStorage } from "@nestjs/throttler";
import { type Clock, systemClock } from "../../src/common/clock.js";
import {
  MemoryRateLimitStore,
  RateLimitStoreUnavailable,
} from "../../src/common/rate-limit/store.js";

/** The in-process store, on the given clock (default: the system clock). */
export function memoryRateLimits(
  clock: Clock = systemClock,
): MemoryRateLimitStore {
  return new MemoryRateLimitStore(clock);
}

/** A store that is always down; `calls` counts the attempts. */
export function failingRateLimits(): ThrottlerStorage & { calls: number } {
  const store = {
    calls: 0,
    increment() {
      store.calls += 1;
      return Promise.reject(new RateLimitStoreUnavailable());
    },
  };
  return store;
}
