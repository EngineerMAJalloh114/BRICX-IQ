// The request context (P4-03, ADR 0053), in AsyncLocalStorage. Lifecycle:
// 1. context.hook.ts creates the store in a Fastify onRequest hook
//    (storage.run(store, done)): correlation id, ip, device id.
// 2. A guard may set the identity once (P5's auth guard will).
// 3. The interceptor seals it: validates the identity, freezes the store.
// 4. Handlers and TxRunner read it; nothing can change it any more.
import { AsyncLocalStorage } from "node:async_hooks";
import { validateTxContext } from "@bricx/db/database";

/** Who the request acts as (set by authentication, from P5). */
export interface Identity {
  readonly userId: string;
  readonly orgId: string;
  readonly projectIds: readonly string[];
  readonly roles: readonly string[];
}

/** A coarse location, when a later task supplies one. */
export interface Geo {
  readonly lat: number;
  readonly lon: number;
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

/** Most roles one identity may carry, and the longest role name. */
export const MAX_ROLES = 64;
export const MAX_ROLE_LENGTH = 100;

interface Store {
  context: RequestContext;
  sealed: boolean;
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
  };
  return storage.run(store, fn);
}

/** The current request's context, or undefined outside a request. */
export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore()?.context;
}

/**
 * Sets the identity, once, before the handler runs (P5's auth guard).
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

/** A frozen, validated copy of `identity`, or InvalidIdentityError. */
function sealIdentity(identity: Identity): Identity {
  let tenant;
  try {
    tenant = validateTxContext(identity);
  } catch {
    throw new InvalidIdentityError();
  }
  const roles: unknown = Reflect.get(identity, "roles");
  if (!Array.isArray(roles) || roles.length > MAX_ROLES) {
    throw new InvalidIdentityError();
  }
  const copy: string[] = [];
  for (let i = 0; i < roles.length; i += 1) {
    const role: unknown = roles[i];
    if (
      typeof role !== "string" ||
      role.length === 0 ||
      role.length > MAX_ROLE_LENGTH
    ) {
      throw new InvalidIdentityError();
    }
    copy.push(role);
  }
  return Object.freeze({ ...tenant, roles: Object.freeze(copy) });
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
