// The rate limiter (P6-05d, ADR 0080): the store (Valkey on the app's
// shared client; a test may hand in another through createApp), the
// in-process fallback, the store-down signal, and the IP-stage global
// guard. AppModule imports this module before AuthModule, so the IP guard
// runs before the AuthGuard; AuthModule registers RateLimitPrincipalGuard
// between the AuthGuard and the CanGuard. Global, so AuthModule's guard
// injects the same store, fallback and signal.
import type { RateLimits } from "@bricx/config/rate-limits";
import { type DynamicModule, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import {
  type ThrottlerStorage,
  getOptionsToken,
  getStorageToken,
} from "@nestjs/throttler";
import type { Clock } from "../clock.js";
import {
  RATE_LIMIT_FALLBACK,
  RATE_LIMIT_SIGNAL,
  RateLimitIpGuard,
  StoreDownSignal,
  rateLimitThrottlers,
} from "./guards.js";
import { MemoryRateLimitStore } from "./store.js";

export interface RateLimitModuleOptions {
  readonly limits: RateLimits;
  readonly store: ThrottlerStorage;
  readonly clock: Clock;
}

@Module({})
export class RateLimitModule {
  static forRoot(options: RateLimitModuleOptions): DynamicModule {
    const tokens = [
      getOptionsToken(),
      getStorageToken(),
      RATE_LIMIT_FALLBACK,
      RATE_LIMIT_SIGNAL,
    ];
    return {
      module: RateLimitModule,
      global: true,
      exports: tokens,
      providers: [
        {
          provide: getOptionsToken(),
          useValue: {
            throttlers: rateLimitThrottlers(options.limits),
            setHeaders: false,
          },
        },
        { provide: getStorageToken(), useValue: options.store },
        {
          provide: RATE_LIMIT_FALLBACK,
          useValue: new MemoryRateLimitStore(options.clock),
        },
        {
          provide: RATE_LIMIT_SIGNAL,
          useValue: new StoreDownSignal(options.clock),
        },
        { provide: APP_GUARD, useClass: RateLimitIpGuard },
      ],
    };
  }
}
