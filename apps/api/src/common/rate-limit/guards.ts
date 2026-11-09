// The rate-limit guards (P6-05d, ADR 0080; owner conditions C1, C2, C8),
// on @nestjs/throttler's ThrottlerGuard (named throttlers ip, user, org;
// limits and windows resolved per route from the config's classes).
// Global guards run: RateLimitIpGuard → AuthGuard →
// RateLimitPrincipalGuard → CanGuard (rate-limit.module.ts registers the
// first before AuthModule; AuthModule registers the third between its two).
// - IP stage, before any token work: a @Public route is counted against
//   its class's ip limit; every other route once against the default
//   class's (loose) ip limit (C1: a NAT of many users is not throttled).
// - Principal stage: the user (and, with an org, the org) against the
//   route's class. A @Public route has no principal: no user or org count.
// - Over a limit: 429 rate_limited with Retry-After (C8), one
//   rate_limit.exceeded info line {class, dim}. The X-RateLimit-* headers
//   are off.
// - Store down (RateLimitStoreUnavailable): "fallback" counts in-process
//   at the same limits; "closed" is 503 server_unavailable with
//   Retry-After 5 (C8). The mode is the bucket's class's, or the route's
//   own (C2). One rate_limit.store_unavailable warn line per class and
//   mode every 10 s. No line carries an address, an id or a key.
import type {
  RateLimitClass,
  RateLimitDimension,
  RateLimits,
} from "@bricx/config/rate-limits";
import { type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  type ThrottlerModuleOptions,
  type ThrottlerOptions,
  type ThrottlerRequest,
  ThrottlerGuard,
  type ThrottlerStorage,
  getOptionsToken,
  getStorageToken,
} from "@nestjs/throttler";
import { IS_PUBLIC } from "../auth/public.decorator.js";
import { signedInUser } from "../auth/signed-in.decorator.js";
import { type Clock } from "../clock.js";
import { currentRequestContext } from "../db/request-context.js";
import { ApiError } from "../errors/api-error.js";
import { ipKeyId, rateLimitKey } from "./keys.js";
import {
  STORE_DOWN_DEFAULTS,
  STORE_DOWN_LOG_INTERVAL_MS,
  STORE_DOWN_RETRY_AFTER_SECONDS,
  type StoreDownMode,
  retryAfterSeconds,
} from "./policy.js";
import { type RouteLimit, routeLimitOf } from "./routes.js";
import { RateLimitStoreUnavailable } from "./store.js";

export const RATE_LIMIT_FALLBACK = Symbol("RATE_LIMIT_FALLBACK");
export const RATE_LIMIT_SIGNAL = Symbol("RATE_LIMIT_SIGNAL");

interface RateLimitRequest {
  readonly ip: string;
  readonly log: {
    info(fields: object, message: string): void;
    warn(fields: object, message: string): void;
  };
}

type Handler = (...args: unknown[]) => unknown;

const reflector = new Reflector();

/** The route's class, or default when the metadata cannot be read. */
function routeOf(context: ExecutionContext): RouteLimit {
  const handler = context.getHandler() as Handler;
  const type = context.getClass();
  // createApp refuses an unknown class at boot (assertRateLimitClasses).
  return (
    routeLimitOf(reflector, handler, type) ?? {
      cls: "default",
      storeDown: STORE_DOWN_DEFAULTS.default,
      exempt: false,
    }
  );
}

const isPublic = (context: ExecutionContext): boolean =>
  reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
    context.getHandler(),
    context.getClass(),
  ]) === true;

interface Bucket {
  readonly cls: RateLimitClass;
  readonly storeDown: StoreDownMode;
}

/** The class a dimension is counted in for this route (C1). */
function bucketOf(context: ExecutionContext, dim: RateLimitDimension): Bucket {
  const route = routeOf(context);
  if (dim === "ip" && !isPublic(context)) {
    return { cls: "default", storeDown: STORE_DOWN_DEFAULTS.default };
  }
  return { cls: route.cls, storeDown: route.storeDown };
}

const principalUser = (): string | undefined =>
  currentRequestContext()?.identity?.userId ?? signedInUser()?.userId;
const principalOrg = (): string | undefined =>
  currentRequestContext()?.identity?.orgId;

const isDimension = (name: string | undefined): name is RateLimitDimension =>
  name === "ip" || name === "user" || name === "org";

/** The named throttlers, their limits and windows from `limits`. */
export function rateLimitThrottlers(limits: RateLimits): ThrottlerOptions[] {
  const throttler = (
    dim: RateLimitDimension,
    tracker: (req: Record<string, unknown>) => string,
    skipIf?: () => boolean,
  ): ThrottlerOptions => ({
    name: dim,
    limit: (context) => limits[bucketOf(context, dim).cls][dim],
    ttl: (context) => limits[bucketOf(context, dim).cls].windowSeconds * 1000,
    getTracker: (req) => tracker(req),
    generateKey: (context, id) =>
      rateLimitKey(bucketOf(context, dim).cls, dim, id),
    ...(skipIf === undefined ? {} : { skipIf }),
    setHeaders: false,
  });
  return [
    throttler("ip", (req) => ipKeyId(typeof req.ip === "string" ? req.ip : "")),
    throttler(
      "user",
      () => principalUser() ?? "",
      () => principalUser() === undefined,
    ),
    throttler(
      "org",
      () => principalOrg() ?? "",
      () => principalOrg() === undefined,
    ),
  ];
}

/** The store-down warn line, at most once per class and mode every 10 s. */
export class StoreDownSignal {
  private readonly last = new Map<string, number>();

  constructor(private readonly clock: Clock) {}

  warn(
    request: RateLimitRequest,
    cls: RateLimitClass,
    mode: "fail_open" | "fail_closed",
  ): void {
    const key = `${cls}/${mode}`;
    const now = this.clock.now();
    const last = this.last.get(key);
    if (last !== undefined && now - last < STORE_DOWN_LOG_INTERVAL_MS) return;
    this.last.set(key, now);
    request.log.warn({ class: cls, mode }, "rate_limit.store_unavailable");
  }
}

abstract class RateLimitGuard extends ThrottlerGuard {
  protected abstract readonly dimensions: readonly RateLimitDimension[];

  constructor(
    options: ThrottlerModuleOptions,
    storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly fallback: ThrottlerStorage,
    private readonly signal: StoreDownSignal,
  ) {
    super(options, storage, reflector);
  }

  override async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    this.throttlers = this.throttlers.filter((t) =>
      this.dimensions.some((dim) => dim === t.name),
    );
  }

  protected override shouldSkip(context: ExecutionContext): Promise<boolean> {
    return Promise.resolve(
      context.getType() !== "http" || routeOf(context).exempt,
    );
  }

  protected override async handleRequest(
    request: ThrottlerRequest,
  ): Promise<boolean> {
    const { context, limit, ttl, throttler, blockDuration } = request;
    const dim = throttler.name;
    if (!isDimension(dim)) return true;
    const req = context.switchToHttp().getRequest<RateLimitRequest>();
    const tracker = await request.getTracker(req, context);
    const key = request.generateKey(context, tracker, dim);
    const bucket = bucketOf(context, dim);
    let record;
    try {
      record = await this.storageService.increment(
        key,
        ttl,
        limit,
        blockDuration,
        dim,
      );
    } catch (error) {
      if (!(error instanceof RateLimitStoreUnavailable)) throw error;
      if (bucket.storeDown === "closed") {
        this.signal.warn(req, bucket.cls, "fail_closed");
        throw new ApiError("server_unavailable", {
          retryAfterSeconds: STORE_DOWN_RETRY_AFTER_SECONDS,
        });
      }
      this.signal.warn(req, bucket.cls, "fail_open");
      record = await this.fallback.increment(
        key,
        ttl,
        limit,
        blockDuration,
        dim,
      );
    }
    if (record.isBlocked) {
      req.log.info({ class: bucket.cls, dim }, "rate_limit.exceeded");
      throw new ApiError("rate_limited", {
        retryAfterSeconds: retryAfterSeconds(record.timeToBlockExpire),
      });
    }
    return true;
  }
}

/** The IP stage: before the AuthGuard. */
@Injectable()
export class RateLimitIpGuard extends RateLimitGuard {
  protected readonly dimensions = ["ip"] as const;

  constructor(
    @Inject(getOptionsToken()) options: ThrottlerModuleOptions,
    @Inject(getStorageToken()) storage: ThrottlerStorage,
    @Inject(Reflector) reflector: Reflector,
    @Inject(RATE_LIMIT_FALLBACK) fallback: ThrottlerStorage,
    @Inject(RATE_LIMIT_SIGNAL) signal: StoreDownSignal,
  ) {
    super(options, storage, reflector, fallback, signal);
  }
}

/** The user and org stage: after the AuthGuard, before the CanGuard. */
@Injectable()
export class RateLimitPrincipalGuard extends RateLimitGuard {
  protected readonly dimensions = ["user", "org"] as const;

  constructor(
    @Inject(getOptionsToken()) options: ThrottlerModuleOptions,
    @Inject(getStorageToken()) storage: ThrottlerStorage,
    @Inject(Reflector) reflector: Reflector,
    @Inject(RATE_LIMIT_FALLBACK) fallback: ThrottlerStorage,
    @Inject(RATE_LIMIT_SIGNAL) signal: StoreDownSignal,
  ) {
    super(options, storage, reflector, fallback, signal);
  }
}
