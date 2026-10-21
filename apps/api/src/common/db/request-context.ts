// The request context (P4-03, ADR 0053), in AsyncLocalStorage. Lifecycle:
// 1. context.hook.ts creates the store in a Fastify onRequest hook
//    (storage.run(store, done)): correlation id, ip, device id.
// 2. The auth guard sets the identity once (P5-02, ADR 0062).
// 3. The interceptor seals it: validates the identity (tenant ids and
//    grants), deep-freezes it, freezes the store.
// 4. Handlers and TxRunner read it; nothing can change it any more.
import { AsyncLocalStorage } from "node:async_hooks";
import { validateTxContext } from "@bricx/db/database";
import { type Grant, parseGrants } from "@bricx/permissions/ability";
import { LIMITS } from "@bricx/permissions/limits";

/**
 * Who the request acts as, set by the auth guard (P5-02, ADR 0062): the
 * org is the token's org_id hint, the user is the users row, projects and
 * grants come from the grants source (none until P5-05). There are no role
 * names: abilityFor() builds the ability from the grants alone.
 */
export interface Identity {
  readonly userId: string;
  readonly orgId: string;
  readonly projectIds: readonly string[];
  readonly grants: readonly Grant[];
}

/**
 * A coarse location, when a later task supplies one: integer
 * micro-degrees (degrees x 1e6), never floats (P4-05, ADR 0055).
 */
export interface Geo {
  readonly latE6: number;
  readonly lonE6: number;
}

export interface RequestContext {
  /** x-request-id (kept when safe, else a new UUIDv7; request-id.ts). */
  readonly correlationId: string;
  /** Fastify's request.ip; trustProxy is set at P13-02 (load balancer). */
  readonly ip: string;
  /** x-device-id when it is a canonical UUID; untrusted until P5. */
  readonly deviceId: string | undefined;
  readonly geo: Geo | undefined;
  readonly identity: Identity | undefined;
}

interface Store {
  context: RequestContext;
  sealed: boolean;
  /** Per-request state of the cross-cutting layers (P4-07: idempotency). */
  slots: Map<symbol, unknown>;
}

const storage = new AsyncLocalStorage<Store>();

export class NoRequestContextError extends Error {
  constructor() {
    super("no request context");
  }
}
Object.defineProperty(NoRequestContextError.prototype, "name", {
  value: "NoRequestContextError",
});

/** The request has no identity (not authenticated), so no tenant. */
export class NoTenantContextError extends Error {
  constructor() {
    super("the request has no tenant identity");
  }
}
Object.defineProperty(NoTenantContextError.prototype, "name", {
  value: "NoTenantContextError",
});

/** The identity is already set, or the handler is already running. */
export class RequestContextSealedError extends Error {
  constructor() {
    super("the request context can no longer change");
  }
}
Object.defineProperty(RequestContextSealedError.prototype, "name", {
  value: "RequestContextSealedError",
});

export class InvalidIdentityError extends Error {
  constructor() {
    super("invalid identity");
  }
}
Object.defineProperty(InvalidIdentityError.prototype, "name", {
  value: "InvalidIdentityError",
});

/** Runs `fn` with a new store holding `context` (the onRequest hook). */
export function runWithRequestContext<T>(
  context: Omit<RequestContext, "identity" | "geo">,
  fn: () => T,
): T {
  const store: Store = {
    context: { ...context, geo: undefined, identity: undefined },
    sealed: false,
    slots: new Map(),
  };
  return storage.run(store, fn);
}

/** The current request's context, or undefined outside a request. */
export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore()?.context;
}

/**
 * Sets the identity, once, before the handler runs (the auth guard).
 * The value is validated and frozen when the interceptor seals the store.
 */
export function setIdentity(identity: Identity): void {
  const store = storage.getStore();
  if (store === undefined) throw new NoRequestContextError();
  if (store.sealed || store.context.identity !== undefined) {
    throw new RequestContextSealedError();
  }
  store.context = { ...store.context, identity };
}

/** A frozen copy of one grant, its target list bounded before it is copied. */
function copyGrant(grant: Grant): Grant {
  const { permission } = grant;
  switch (grant.scope) {
    case "project":
      if (grant.projectIds.length > LIMITS.targetsPerGrant) {
        throw new InvalidIdentityError();
      }
      return Object.freeze({
        permission,
        scope: "project",
        projectIds: Object.freeze([...grant.projectIds]),
      });
    case "site":
      if (grant.siteIds.length > LIMITS.targetsPerGrant) {
        throw new InvalidIdentityError();
      }
      return Object.freeze({
        permission,
        scope: "site",
        siteIds: Object.freeze([...grant.siteIds]),
      });
    case "org":
      return Object.freeze({ permission, scope: "org" });
    case "own":
      return Object.freeze({ permission, scope: "own" });
  }
}

/**
 * A frozen copy of the grants, validated by @bricx/permissions (bounded,
 * closed keys, known permissions and scopes, UUIDv7 targets) after the
 * copy, so what is checked is what the handler reads.
 */
function sealGrants(grants: readonly Grant[]): readonly Grant[] {
  if (!Array.isArray(grants) || grants.length > LIMITS.grants) {
    throw new InvalidIdentityError();
  }
  try {
    const copy = grants.map(copyGrant);
    parseGrants(copy);
    return Object.freeze(copy);
  } catch {
    throw new InvalidIdentityError();
  }
}

/** A frozen, validated copy of `identity`, or InvalidIdentityError. */
function sealIdentity(identity: Identity): Identity {
  let tenant;
  try {
    tenant = validateTxContext(identity);
  } catch {
    throw new InvalidIdentityError();
  }
  const grants = sealGrants(identity.grants);
  return Object.freeze({ ...tenant, grants });
}

/**
 * Validates the identity (if any) and freezes the context, so the handler
 * and everything after it read a fixed copy (the interceptor).
 */
export function sealRequestContext(): RequestContext {
  const store = storage.getStore();
  if (store === undefined) throw new NoRequestContextError();
  if (!store.sealed) {
    const { identity } = store.context;
    store.context = Object.freeze({
      ...store.context,
      identity: identity === undefined ? undefined : sealIdentity(identity),
    });
    store.sealed = true;
  }
  return store.context;
}

/**
 * Keeps `value` under `slot` for the rest of the request (P4-07: the
 * idempotency interceptor hands its state to TxRunner this way). Slots
 * are independent of the sealed context. Outside a request:
 * NoRequestContextError.
 */
export function setRequestSlot(slot: symbol, value: unknown): void {
  const store = storage.getStore();
  if (store === undefined) throw new NoRequestContextError();
  store.slots.set(slot, value);
}

/** The value kept under `slot`, or undefined (also outside a request). */
export function requestSlot(slot: symbol): unknown {
  return storage.getStore()?.slots.get(slot);
}
