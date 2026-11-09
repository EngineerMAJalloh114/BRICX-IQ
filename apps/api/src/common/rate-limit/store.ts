// The rate-limit stores (P6-05d, ADR 0080; owner conditions C3 and C4),
// both @nestjs/throttler ThrottlerStorage: a fixed window per key.
// - ValkeyRateLimitStore: one Lua script per hit on the app's shared
//   client (common/valkey.ts: 500 ms bounds, no offline queue). INCR, then
//   PEXPIRE whenever the key has no expiry (PTTL -1), on any hit and not
//   only the first, so a key can never live forever (C4); Valkey runs
//   noeviction (C3), so every rl:v1:* key must carry a TTL. Any failure is
//   RateLimitStoreUnavailable (no host, key or value in it).
// - MemoryRateLimitStore: the in-process fallback, an LRU of at most
//   10,000 keys per process, on the injected clock.
import type { ThrottlerStorage } from "@nestjs/throttler";
import type { Redis } from "ioredis";
import type { Clock } from "../clock.js";
import { ensureConnected } from "../valkey.js";

export class RateLimitStoreUnavailable extends Error {
  constructor() {
    super("rate-limit store unavailable");
  }
}
Object.defineProperty(RateLimitStoreUnavailable.prototype, "name", {
  value: "RateLimitStoreUnavailable",
});

/** What increment() answers (ThrottlerStorageRecord; times in seconds). */
export interface RateLimitRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

function recordOf(
  hits: number,
  msLeft: number,
  limit: number,
): RateLimitRecord {
  const seconds = Math.max(0, Math.ceil(msLeft / 1000));
  return {
    totalHits: hits,
    timeToExpire: seconds,
    isBlocked: hits > limit,
    timeToBlockExpire: hits > limit ? seconds : 0,
  };
}

/** KEYS[1] the key, ARGV[1] the window in ms; returns {hits, pttl}. */
export const RATE_LIMIT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {hits, ttl}
`;

export class ValkeyRateLimitStore implements ThrottlerStorage {
  constructor(private readonly client: Redis) {}

  // ThrottlerStorage also passes blockDuration and the throttler name;
  // a fixed window blocks until the window ends, so neither is read.
  async increment(
    key: string,
    ttl: number,
    limit: number,
  ): Promise<RateLimitRecord> {
    let answer: unknown;
    try {
      await ensureConnected(this.client);
      answer = await this.client.eval(RATE_LIMIT_SCRIPT, 1, key, String(ttl));
    } catch {
      throw new RateLimitStoreUnavailable();
    }
    if (
      !Array.isArray(answer) ||
      typeof answer[0] !== "number" ||
      typeof answer[1] !== "number"
    ) {
      throw new RateLimitStoreUnavailable();
    }
    return recordOf(answer[0], answer[1], limit);
  }
}

/** Most keys the in-process store holds. */
export const FALLBACK_MAX_KEYS = 10_000;

interface Window {
  hits: number;
  expiresAt: number;
}

export class MemoryRateLimitStore implements ThrottlerStorage {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly clock: Clock,
    private readonly maxKeys: number = FALLBACK_MAX_KEYS,
  ) {}

  /** Keys held now. */
  get size(): number {
    return this.windows.size;
  }

  increment(key: string, ttl: number, limit: number): Promise<RateLimitRecord> {
    const now = this.clock.now();
    let window = this.windows.get(key);
    if (window === undefined || window.expiresAt <= now) {
      window = { hits: 0, expiresAt: now + ttl };
    }
    window.hits += 1;
    // Most recently used last: delete and set again.
    this.windows.delete(key);
    this.windows.set(key, window);
    while (this.windows.size > this.maxKeys) {
      const oldest = this.windows.keys().next();
      if (oldest.done === true) break;
      this.windows.delete(oldest.value);
    }
    return Promise.resolve(
      recordOf(window.hits, window.expiresAt - now, limit),
    );
  }
}
