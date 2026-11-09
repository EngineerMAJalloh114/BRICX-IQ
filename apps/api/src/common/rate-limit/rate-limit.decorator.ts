// Route markers of the rate limiter (P6-05d, ADR 0080; owner condition
// C2). @RateLimit(cls) puts a route (or a controller) in a limit class;
// unmarked routes are "default". { storeDown } overrides what the class
// does when the store is down (C2: the directory resolve route falls
// back in-process). @RateLimitExempt() takes a route out entirely (the
// health probes only); it is also an OpenAPI extension, so the document
// lists no 429 there. createApp refuses an unknown class (routes.ts).
import type { RateLimitClass } from "@bricx/config/rate-limits";
import { SetMetadata, applyDecorators } from "@nestjs/common";
import { ApiExtension } from "@nestjs/swagger";
import type { StoreDownMode } from "./policy.js";

export const RATE_LIMIT = "bricx:rate-limit";
export const RATE_LIMIT_EXEMPT = "bricx:rate-limit-exempt";
/** The OpenAPI extension on an exempt operation. */
export const RATE_LIMIT_EXEMPT_EXTENSION = "x-bricx-rate-limit-exempt";

export interface RateLimitRule {
  readonly cls: RateLimitClass;
  readonly storeDown?: StoreDownMode;
}

export const RateLimit = (
  cls: RateLimitClass,
  options: { readonly storeDown?: StoreDownMode } = {},
) =>
  SetMetadata<string, RateLimitRule>(RATE_LIMIT, {
    cls,
    ...(options.storeDown === undefined
      ? {}
      : { storeDown: options.storeDown }),
  });

export const RateLimitExempt = () =>
  applyDecorators(
    SetMetadata(RATE_LIMIT_EXEMPT, true),
    ApiExtension(RATE_LIMIT_EXEMPT_EXTENSION, true),
  );
