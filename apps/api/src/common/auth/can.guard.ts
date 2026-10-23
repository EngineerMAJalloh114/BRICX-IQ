// The authorization guard (P5-07, ADR 0068; Done when DW2 and DW3, owner
// decisions D-E, D-F as changed, D-I, conditions 1, 3, 4 and 5). Global,
// after the AuthGuard (auth.module.ts registers it second), so it only
// sees requests with an identity. Per route:
// - @Public(): nothing to check;
// - @NoPermission(reason): a self-service route; its service checks it;
// - @Can(permission, { projectParam, siteParam }): the identity's ability
//   (abilityFor over the sealed identity: the grants the grants source
//   read, elevations included, so there is no second path to an elevated
//   key) must allow the permission at the scope the route parameters name:
//   the org for an org resource; the project (and site) in the path for a
//   project (or site) resource whose rule names the parameters. A rule
//   without them, or a parameter that is not a lowercase UUIDv7 (the
//   route's own pipe answers it 422), asks whether the action is held
//   anywhere in the org; the service then checks the record. A resource
//   whose rows carry created_by is checked as a row the caller created
//   (own scope counts; the service checks the real row; both fallbacks
//   for architect review). Refused: 403
//   `forbidden`, one `authz.denied` line with the permission;
// - allowed, a finance key (requiresMfa, MFA_KEY_PREFIX) at acr other than
//   mfa is 401 permission.step_up_required (RFC 9470 challenge, the
//   problem filter), never 403 and never session_expired; one
//   `authz.step_up` line with the permission. A key the user does not hold
//   is 403 at any acr: stepping up would not help;
// - none of the three: 403 `forbidden` and one `authz.unmarked_route` line
//   (createApp already refuses such an app, route-markers.ts).
// The guard seals the request context itself (the interceptor's seal is
// then a no-op), so it reads exactly the identity the handler reads.
import { isProjectId, isSiteId } from "@bricx/ids/branded";
import {
  type Ability,
  type PermissionRecord,
  canPermission,
  rulesOf,
} from "@bricx/permissions/ability";
import { resourceOf, splitPermission } from "@bricx/permissions/catalogue";
import { PermissionError } from "@bricx/permissions/errors";
import { requiresMfa } from "@bricx/permissions/mfa";
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { sealRequestContext } from "../db/request-context.js";
import type { Identity } from "../db/request-context.js";
import { ApiError } from "../errors/api-error.js";
import { abilityFor } from "./ability.js";
import { CAN, type CanRule, NO_PERMISSION } from "./can.decorator.js";
import { IS_PUBLIC } from "./public.decorator.js";
import { MFA_ACR } from "./token-verifier.js";

interface CanRequest {
  readonly params?: Readonly<Record<string, string | undefined>>;
  readonly log: { warn(fields: object, message: string): void };
}

/** Whether the ability holds the rule's action on any record of the org. */
function heldAnywhere(ability: Ability, rule: CanRule): boolean {
  const parts = splitPermission(rule.permission);
  if (parts === undefined) return false;
  return rulesOf(ability).some(
    (r) =>
      r.inverted !== true &&
      r.subject === parts.subject &&
      r.action === parts.action,
  );
}

/** The record the route's parameters name, or undefined (check anywhere). */
function recordOf(
  rule: CanRule,
  identity: Identity,
  params: Readonly<Record<string, string | undefined>>,
  createdBy: boolean,
): PermissionRecord | undefined {
  const base = {
    orgId: identity.orgId,
    ...(createdBy ? { createdBy: identity.userId } : {}),
  };
  if (rule.level === "org") return base;
  const projectId =
    rule.projectParam === undefined ? undefined : params[rule.projectParam];
  if (!isProjectId(projectId)) return undefined;
  if (rule.level === "project") return { ...base, projectId };
  const siteId =
    rule.siteParam === undefined ? undefined : params[rule.siteParam];
  if (!isSiteId(siteId)) return undefined;
  return { ...base, projectId, siteId };
}

@Injectable()
export class CanGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== "http") return true;
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC,
      targets,
    );
    if (isPublic === true) return true;
    const request = context.switchToHttp().getRequest<CanRequest>();
    const rule = this.reflector.get<CanRule | undefined>(
      CAN,
      context.getHandler(),
    );
    if (rule === undefined) {
      const reason = this.reflector.getAllAndOverride<string | undefined>(
        NO_PERMISSION,
        targets,
      );
      if (typeof reason === "string") return true;
      request.log.warn({}, "authz.unmarked_route");
      throw new ApiError("forbidden");
    }
    const { identity } = sealRequestContext();
    if (identity === undefined) throw new ApiError("forbidden");
    const { permission } = rule;
    if (!this.allows(identity, rule, request.params ?? {})) {
      request.log.warn({ permission }, "authz.denied");
      throw new ApiError("forbidden");
    }
    if (requiresMfa([permission]) && identity.acr !== MFA_ACR) {
      request.log.warn({ permission }, "authz.step_up");
      throw new ApiError("permission.step_up_required");
    }
    return true;
  }

  private allows(
    identity: Identity,
    rule: CanRule,
    params: Readonly<Record<string, string | undefined>>,
  ): boolean {
    const ability = abilityFor(identity);
    const subject = splitPermission(rule.permission)?.subject;
    const createdBy =
      subject !== undefined && resourceOf(subject)?.createdBy === true;
    const record = recordOf(rule, identity, params, createdBy);
    if (record === undefined) return heldAnywhere(ability, rule);
    try {
      return canPermission(ability, rule.permission, record);
    } catch (error) {
      // A record the catalogue refuses is a refusal, never a 500.
      if (error instanceof PermissionError) return false;
      throw error;
    }
  }
}
