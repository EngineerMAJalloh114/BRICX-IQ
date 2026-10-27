// The route markers (P5-07, ADR 0068; owner decision D-E and condition 5):
// every route of the app carries @Can, @NoPermission or @Public.
// controllerMarkers() reads one controller's routes from the decorator
// metadata; routeMarkers() reads every controller the app registered;
// assertEveryRouteMarked() is createApp's boot check, so an unmarked route
// (a src controller or a test-only one) stops the app from starting
// (fail closed). The guard refuses such a route as well (can.guard.ts).
import {
  type INestApplication,
  RequestMethod,
  type Type,
} from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { ModulesContainer, Reflector } from "@nestjs/core";
import { CAN, type CanRule, NO_PERMISSION } from "./can.decorator.js";
import { IS_PUBLIC } from "./public.decorator.js";

export type Marker =
  | {
      readonly kind: "can";
      readonly permission: string;
      readonly projectParam?: string;
      readonly siteParam?: string;
      readonly anywhere?: true;
    }
  | { readonly kind: "none"; readonly reason: string }
  | { readonly kind: "public" }
  | { readonly kind: "unmarked" };

export interface RouteMarker {
  /** "METHOD /controller/path" (unversioned). */
  readonly route: string;
  /** "Controller.method". */
  readonly handler: string;
  readonly marker: Marker;
}

const reflector = new Reflector();

type Handler = (...args: unknown[]) => unknown;
const isHandler = (value: unknown): value is Handler =>
  typeof value === "function";
const isType = (value: unknown): value is Type => typeof value === "function";

const pathsOf = (value: unknown): string[] => {
  const list: unknown[] = Array.isArray(value) ? value : [value];
  return list.filter((p): p is string => typeof p === "string");
};

const join = (...parts: string[]): string =>
  `/${parts
    .flatMap((p) => p.split("/"))
    .filter((p) => p.length > 0)
    .join("/")}`;

function markerOf(handler: Handler, type: Type): Marker {
  const rule = reflector.get<CanRule | undefined>(CAN, handler);
  if (rule !== undefined) {
    return {
      kind: "can",
      permission: rule.permission,
      ...(rule.projectParam === undefined
        ? {}
        : { projectParam: rule.projectParam }),
      ...(rule.siteParam === undefined ? {} : { siteParam: rule.siteParam }),
      ...(rule.anywhere === true ? { anywhere: true } : {}),
    };
  }
  const reason = reflector.getAllAndOverride<string | undefined>(
    NO_PERMISSION,
    [handler, type],
  );
  if (typeof reason === "string") return { kind: "none", reason };
  const isPublic = reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
    handler,
    type,
  ]);
  if (isPublic === true) return { kind: "public" };
  return { kind: "unmarked" };
}

/** The routes of one controller class and their markers. */
export function controllerMarkers(type: Type): RouteMarker[] {
  const out: RouteMarker[] = [];
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
      const marker = markerOf(handler, type);
      for (const base of bases.length === 0 ? [""] : bases) {
        for (const path of paths) {
          out.push({
            route: `${RequestMethod[method]} ${join(base, path)}`,
            handler: `${type.name}.${name}`,
            marker,
          });
        }
      }
    }
  }
  return out;
}

/** Every route of every controller the app registered. */
export function routeMarkers(app: INestApplication): RouteMarker[] {
  const out: RouteMarker[] = [];
  const types = new Set<Type>();
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const type: unknown = wrapper.metatype;
      if (isType(type)) types.add(type);
    }
  }
  for (const type of types) out.push(...controllerMarkers(type));
  return out;
}

/** Throws when any route of the app is unmarked (createApp's boot check). */
export function assertEveryRouteMarked(app: INestApplication): void {
  const unmarked = routeMarkers(app).filter(
    (r) => r.marker.kind === "unmarked",
  );
  if (unmarked.length > 0) {
    throw new Error(
      `unmarked route: ${unmarked.map((r) => r.handler).join(", ")}`,
    );
  }
}
