// The rate-limit class of each route (P6-05d, ADR 0080): read from the
// @RateLimit / @RateLimitExempt metadata (handler first, then class),
// unmarked = default with the class's store-down mode. rateLimitRoutes()
// lists every route of the app (the classing test pins the table);
// assertRateLimitClasses() is createApp's boot check: a route naming a
// class the config does not know stops the app (fail closed), like
// assertEveryRouteMarked().
import {
  RATE_LIMIT_CLASSES,
  type RateLimitClass,
} from "@bricx/config/rate-limits";
import {
  type INestApplication,
  RequestMethod,
  type Type,
} from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { ModulesContainer, Reflector } from "@nestjs/core";
import { STORE_DOWN_DEFAULTS, type StoreDownMode } from "./policy.js";
import {
  RATE_LIMIT,
  RATE_LIMIT_EXEMPT,
  type RateLimitRule,
} from "./rate-limit.decorator.js";

export interface RouteLimit {
  readonly cls: RateLimitClass;
  readonly storeDown: StoreDownMode;
  readonly exempt: boolean;
}

const KNOWN: ReadonlySet<string> = new Set(RATE_LIMIT_CLASSES);
const isClass = (value: unknown): value is RateLimitClass =>
  typeof value === "string" && KNOWN.has(value);

type Handler = (...args: unknown[]) => unknown;

/** The class a handler of `type` is in; undefined for an unknown class. */
export function routeLimitOf(
  reflector: Reflector,
  handler: Handler,
  type: Type,
): RouteLimit | undefined {
  const exempt =
    reflector.getAllAndOverride<boolean | undefined>(RATE_LIMIT_EXEMPT, [
      handler,
      type,
    ]) === true;
  const rule = reflector.getAllAndOverride<RateLimitRule | undefined>(
    RATE_LIMIT,
    [handler, type],
  );
  if (rule === undefined) {
    return { cls: "default", storeDown: STORE_DOWN_DEFAULTS.default, exempt };
  }
  if (!isClass(rule.cls)) return undefined;
  return {
    cls: rule.cls,
    storeDown: rule.storeDown ?? STORE_DOWN_DEFAULTS[rule.cls],
    exempt,
  };
}

export interface RouteRateLimit extends RouteLimit {
  /** "METHOD /controller/path" (unversioned). */
  readonly route: string;
  /** "Controller.method". */
  readonly handler: string;
}

const reflector = new Reflector();
const isHandler = (value: unknown): value is Handler =>
  typeof value === "function";
const isType = (value: unknown): value is Type => typeof value === "function";
const pathsOf = (value: unknown): string[] =>
  (Array.isArray(value) ? (value as unknown[]) : [value]).filter(
    (p): p is string => typeof p === "string",
  );
const join = (...parts: string[]): string =>
  `/${parts
    .flatMap((p) => p.split("/"))
    .filter((p) => p.length > 0)
    .join("/")}`;

interface Scanned {
  readonly route: string;
  readonly handler: string;
  readonly limit: RouteLimit | undefined;
}

function scan(app: INestApplication): Scanned[] {
  const types = new Set<Type>();
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const type: unknown = wrapper.metatype;
      if (isType(type)) types.add(type);
    }
  }
  const out: Scanned[] = [];
  for (const type of types) {
    const bases = pathsOf(reflector.get<unknown>(PATH_METADATA, type));
    const seen = new Set<string>();
    for (
      let proto: unknown = type.prototype;
      proto !== null && proto !== Object.prototype && typeof proto === "object";
      proto = Object.getPrototypeOf(proto)
    ) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === "constructor" || seen.has(name)) continue;
        const handler: unknown = Reflect.get(proto, name);
        if (!isHandler(handler)) continue;
        const method = reflector.get<RequestMethod | undefined>(
          METHOD_METADATA,
          handler,
        );
        const paths = pathsOf(reflector.get<unknown>(PATH_METADATA, handler));
        if (method === undefined || paths.length === 0) continue;
        seen.add(name);
        const limit = routeLimitOf(reflector, handler, type);
        for (const base of bases.length === 0 ? [""] : bases) {
          for (const path of paths) {
            out.push({
              route: `${RequestMethod[method]} ${join(base, path)}`,
              handler: `${type.name}.${name}`,
              limit,
            });
          }
        }
      }
    }
  }
  return out;
}

/** Every route of the app with its class (throws on an unknown class). */
export function rateLimitRoutes(app: INestApplication): RouteRateLimit[] {
  assertRateLimitClasses(app);
  return scan(app).flatMap(({ route, handler, limit }) =>
    limit === undefined ? [] : [{ route, handler, ...limit }],
  );
}

/** Throws when any route names an unknown class (createApp's boot check). */
export function assertRateLimitClasses(app: INestApplication): void {
  const unknown = scan(app).filter((r) => r.limit === undefined);
  if (unknown.length > 0) {
    throw new Error(
      `unknown rate limit class: ${unknown.map((r) => r.handler).join(", ")}`,
    );
  }
}
