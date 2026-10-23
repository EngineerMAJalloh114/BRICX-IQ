// @Can() and @NoPermission() (P5-07, ADR 0068; owner decision D-E and
// condition 5): what the authorization guard (can.guard.ts) checks on a
// route, declared next to the route.
// - @Can(permission, { projectParam, siteParam }): a catalogue permission
//   (module.resource.action, @bricx/permissions) and the route parameters
//   that name its scope. canRule() checks the declaration when the class is
//   declared, so an unknown permission or a parameter the resource's level
//   cannot have stops the app from loading (boot), never a request;
// - @NoPermission(reason): a self-service route (the caller's own rows),
//   checked in its service; the reason is kept so the route list says why;
// - @Public() (public.decorator.ts) skips both guards.
// A route with none of the three makes createApp fail (route-markers.ts)
// and is refused by the guard (fail closed). The service-level checks
// (assertCan, holdsAll, target protection) stay where they are: the guard
// is the first layer, not a replacement.
import {
  type PermissionName,
  isPermissionName,
  resourceOf,
  splitPermission,
} from "@bricx/permissions/catalogue";
import type { Level } from "@bricx/permissions/catalogue";
import { SetMetadata } from "@nestjs/common";

/** The metadata key of a @Can() rule (the handler only). */
export const CAN = "bricx:can";
/** The metadata key of a @NoPermission() reason (handler, then class). */
export const NO_PERMISSION = "bricx:no-permission";

export interface CanOptions {
  /** The route parameter holding the project id (project and site resources). */
  readonly projectParam?: string;
  /** The route parameter holding the site id (site resources, with projectParam). */
  readonly siteParam?: string;
}

/** A checked @Can() declaration. */
export interface CanRule {
  readonly permission: PermissionName;
  readonly level: Level;
  readonly projectParam?: string;
  readonly siteParam?: string;
}

export type CanDeclarationErrorCode =
  "unknown_permission" | "invalid_param" | "invalid_reason";

/** A @Can() or @NoPermission() the app must not load with. */
export class CanDeclarationError extends Error {
  constructor(readonly code: CanDeclarationErrorCode) {
    super(`route declaration: ${code}`);
  }
}
Object.defineProperty(CanDeclarationError.prototype, "name", {
  value: "CanDeclarationError",
});

const PARAM = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const MAX_REASON_LENGTH = 200;

const paramOf = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !PARAM.test(value)) {
    throw new CanDeclarationError("invalid_param");
  }
  return value;
};

/** The checked rule for a declaration, or CanDeclarationError. */
export function canRule(permission: unknown, options: unknown): CanRule {
  if (!isPermissionName(permission)) {
    throw new CanDeclarationError("unknown_permission");
  }
  const subject = splitPermission(permission)?.subject;
  const resource = subject === undefined ? undefined : resourceOf(subject);
  if (resource === undefined) {
    throw new CanDeclarationError("unknown_permission");
  }
  if (typeof options !== "object" || options === null) {
    throw new CanDeclarationError("invalid_param");
  }
  const projectParam = paramOf(Reflect.get(options, "projectParam"));
  const siteParam = paramOf(Reflect.get(options, "siteParam"));
  const { level } = resource;
  if (
    (projectParam !== undefined && level === "org") ||
    (siteParam !== undefined &&
      (level !== "site" || projectParam === undefined))
  ) {
    throw new CanDeclarationError("invalid_param");
  }
  return Object.freeze({
    permission,
    level,
    ...(projectParam === undefined ? {} : { projectParam }),
    ...(siteParam === undefined ? {} : { siteParam }),
  });
}

/** The route needs `permission`, at the scope its parameters name. */
export const Can = (
  permission: PermissionName,
  options: CanOptions = {},
): MethodDecorator => SetMetadata(CAN, canRule(permission, options));

/** A self-service route, checked in its service; `reason` says why. */
export const NoPermission = (
  reason: string,
): MethodDecorator & ClassDecorator => {
  if (
    typeof reason !== "string" ||
    reason.length === 0 ||
    reason.length > MAX_REASON_LENGTH
  ) {
    throw new CanDeclarationError("invalid_reason");
  }
  return SetMetadata(NO_PERMISSION, reason);
};
