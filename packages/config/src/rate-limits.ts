// Rate limits and the trusted proxy (P6-05d, ADR 0080; owner condition
// C1). The defaults are estimates until the P14 load tests (C6): they are
// config, not code, and apps/api holds no limit literal.
// - Five classes; each has an ip, a user and an org limit per window.
//   C1: the class's ip limit applies only to @Public routes; every other
//   route counts once against the default class's ip limit, which is
//   loose (6000 per 60 s) so a site behind one NAT is never throttled by
//   its address.
// - RATE_LIMIT_<CLASS> overrides one class: "ip=N,user=N,org=N,window=S",
//   every field exactly once, limits 1-1,000,000, window 1-86,400 s.
// - TRUST_PROXY: unset or "off" (request.ip is the socket peer), "hops:N"
//   (1-3) or a list of CIDRs. Trusting everyone ("true", a /0) is refused;
//   production refuses it unset or off (api.ts).
// Client-safe like load.ts: no Node built-in import, nothing read at load.

export const RATE_LIMIT_CLASSES = [
  "default",
  "auth_adjacent",
  "invitation",
  "upload",
  "export",
] as const;
export type RateLimitClass = (typeof RATE_LIMIT_CLASSES)[number];

/** The dimensions a class limits. */
export const RATE_LIMIT_DIMENSIONS = ["ip", "user", "org"] as const;
export type RateLimitDimension = (typeof RATE_LIMIT_DIMENSIONS)[number];

export interface RateLimit {
  readonly ip: number;
  readonly user: number;
  readonly org: number;
  readonly windowSeconds: number;
}

export type RateLimits = Readonly<Record<RateLimitClass, RateLimit>>;

const freeze = (limit: RateLimit): RateLimit => Object.freeze({ ...limit });

/** The approved defaults (owner ruling C1, 2026-11-09). */
export const RATE_LIMIT_DEFAULTS: RateLimits = Object.freeze({
  default: freeze({ ip: 6000, user: 600, org: 30_000, windowSeconds: 60 }),
  auth_adjacent: freeze({ ip: 30, user: 20, org: 600, windowSeconds: 600 }),
  invitation: freeze({ ip: 60, user: 50, org: 200, windowSeconds: 3600 }),
  upload: freeze({ ip: 120, user: 60, org: 1200, windowSeconds: 60 }),
  export: freeze({ ip: 30, user: 10, org: 100, windowSeconds: 3600 }),
});

/** The environment key that overrides each class. */
export const RATE_LIMIT_ENV_KEYS = Object.freeze({
  default: "RATE_LIMIT_DEFAULT",
  auth_adjacent: "RATE_LIMIT_AUTH_ADJACENT",
  invitation: "RATE_LIMIT_INVITATION",
  upload: "RATE_LIMIT_UPLOAD",
  export: "RATE_LIMIT_EXPORT",
} as const satisfies Record<RateLimitClass, string>);

const LIMIT_MAX = 1_000_000;
const WINDOW_MAX_SECONDS = 86_400;
const FIELD = /^(ip|user|org|window)=([1-9]\d{0,6})$/;

/** "ip=N,user=N,org=N,window=S", or undefined when anything is off. */
export function parseRateLimit(text: string): RateLimit | undefined {
  if (text.length > 100) return undefined;
  const fields = new Map<string, number>();
  for (const part of text.split(",")) {
    const match = FIELD.exec(part);
    if (match === null) return undefined;
    const [, name = "", digits = ""] = match;
    if (fields.has(name)) return undefined;
    fields.set(name, Number(digits));
  }
  const ip = fields.get("ip");
  const user = fields.get("user");
  const org = fields.get("org");
  const windowSeconds = fields.get("window");
  if (
    ip === undefined ||
    user === undefined ||
    org === undefined ||
    windowSeconds === undefined ||
    [ip, user, org].some((n) => n > LIMIT_MAX) ||
    windowSeconds > WINDOW_MAX_SECONDS
  ) {
    return undefined;
  }
  return Object.freeze({ ip, user, org, windowSeconds });
}

export type TrustProxy =
  | { readonly mode: "off" }
  | { readonly mode: "hops"; readonly hops: number }
  | { readonly mode: "cidrs"; readonly cidrs: readonly string[] };

const IPV4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isCidr(item: string): boolean {
  const slash = item.indexOf("/");
  if (slash < 0) return false;
  const address = item.slice(0, slash);
  const bits = item.slice(slash + 1);
  if (!/^[1-9]\d{0,2}$/.test(bits)) return false;
  const prefix = Number(bits);
  if (IPV4.test(address)) return prefix <= 32;
  // An IPv6 literal is valid exactly when it parses as a URL host.
  return (
    /^[0-9a-fA-F:.]+$/.test(address) &&
    address.includes(":") &&
    URL.canParse(`http://[${address}]/`) &&
    prefix <= 128
  );
}

/** "off", "hops:N" (1-3) or a CIDR list; undefined when anything is off. */
export function parseTrustProxy(text: string): TrustProxy | undefined {
  if (text === "off") return Object.freeze({ mode: "off" });
  const hops = /^hops:([1-3])$/.exec(text);
  if (hops !== null)
    return Object.freeze({ mode: "hops", hops: Number(hops[1]) });
  if (text.length > 1_000) return undefined;
  const cidrs = text.split(",");
  if (!cidrs.every(isCidr)) return undefined;
  return Object.freeze({ mode: "cidrs", cidrs: Object.freeze(cidrs) });
}

/** The value Fastify's trustProxy option takes. */
export function fastifyTrustProxy(
  trust: TrustProxy,
): false | number | string[] {
  if (trust.mode === "off") return false;
  if (trust.mode === "hops") return trust.hops;
  return [...trust.cidrs];
}
