// Rate limits and the trusted proxy (P6-05d, ADR 0080; owner conditions
// C1 and C6):
// - five classes, each an ip, a user and an org limit per window; the
//   defaults are a frozen table here (no limit literal in apps/api), with
//   C1's numbers: default ip 6000 per 60 s (the one loose pre-auth limit
//   of every authenticated route) and auth_adjacent org 600 per 600 s;
// - RATE_LIMIT_<CLASS> overrides one class: "ip=N,user=N,org=N,window=S",
//   every field once, bounded; anything else is a ConfigError naming the
//   key and a code, never the value;
// - TRUST_PROXY: off (unset or "off"), "hops:N" (1-3) or a CIDR list;
//   "true" (trust everyone) is refused; production refuses it unset or off
//   (every client would share the load balancer's address).
import { describe, expect, it } from "vitest";
import { ConfigError, apiKeys, loadApiConfig } from "../src/api.js";
import {
  RATE_LIMIT_CLASSES,
  RATE_LIMIT_DEFAULTS,
  RATE_LIMIT_ENV_KEYS,
  type RateLimit,
  fastifyTrustProxy,
  parseRateLimit,
  parseTrustProxy,
} from "../src/rate-limits.js";
import { devApiEnv, prodApiEnv, without } from "./env.js";

function problemsOf(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems.map((p) => `${p.key}:${p.code}`);
  }
  return [];
}

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  return "";
}

describe("the classes and their defaults (C1)", () => {
  it("are default, auth_adjacent, invitation, upload and export", () => {
    expect([...RATE_LIMIT_CLASSES]).toEqual([
      "default",
      "auth_adjacent",
      "invitation",
      "upload",
      "export",
    ]);
  });

  it("hold the approved table, frozen", () => {
    const table: Record<string, RateLimit> = {
      default: { ip: 6000, user: 600, org: 30_000, windowSeconds: 60 },
      auth_adjacent: { ip: 30, user: 20, org: 600, windowSeconds: 600 },
      invitation: { ip: 60, user: 50, org: 200, windowSeconds: 3600 },
      upload: { ip: 120, user: 60, org: 1200, windowSeconds: 60 },
      export: { ip: 30, user: 10, org: 100, windowSeconds: 3600 },
    };
    expect(RATE_LIMIT_DEFAULTS).toEqual(table);
    expect(Object.isFrozen(RATE_LIMIT_DEFAULTS)).toBe(true);
    for (const cls of RATE_LIMIT_CLASSES) {
      expect(Object.isFrozen(RATE_LIMIT_DEFAULTS[cls]), cls).toBe(true);
    }
  });

  it("every class has one optional override key, declared by the API", () => {
    expect(RATE_LIMIT_ENV_KEYS).toEqual({
      default: "RATE_LIMIT_DEFAULT",
      auth_adjacent: "RATE_LIMIT_AUTH_ADJACENT",
      invitation: "RATE_LIMIT_INVITATION",
      upload: "RATE_LIMIT_UPLOAD",
      export: "RATE_LIMIT_EXPORT",
    });
    for (const key of [...Object.values(RATE_LIMIT_ENV_KEYS), "TRUST_PROXY"]) {
      expect(apiKeys).toContain(key);
    }
  });

  it("unset, the config carries the defaults", () => {
    expect(loadApiConfig(devApiEnv).rateLimits).toEqual(RATE_LIMIT_DEFAULTS);
    expect(loadApiConfig(prodApiEnv).rateLimits).toEqual(RATE_LIMIT_DEFAULTS);
  });
});

describe("RATE_LIMIT_<CLASS> overrides", () => {
  it("parse in any order, every field once", () => {
    expect(parseRateLimit("ip=600,user=600,org=30000,window=60")).toEqual({
      ip: 600,
      user: 600,
      org: 30_000,
      windowSeconds: 60,
    });
    expect(parseRateLimit("window=1,org=3,user=2,ip=1")).toEqual({
      ip: 1,
      user: 2,
      org: 3,
      windowSeconds: 1,
    });
    expect(parseRateLimit("ip=1000000,user=1,org=1,window=86400")).toEqual({
      ip: 1_000_000,
      user: 1,
      org: 1,
      windowSeconds: 86_400,
    });
  });

  it.each([
    "",
    "ip=600",
    "ip=600,user=600,org=30000",
    "ip=600,user=600,org=30000,window=60,ip=1",
    "ip=600,user=600,org=30000,window=60,extra=1",
    "ip=0,user=600,org=30000,window=60",
    "ip=1000001,user=600,org=30000,window=60",
    "ip=600,user=600,org=30000,window=0",
    "ip=600,user=600,org=30000,window=86401",
    "ip=-1,user=600,org=30000,window=60",
    "ip=1.5,user=600,org=30000,window=60",
    "ip=0x10,user=600,org=30000,window=60",
    "ip=600, user=600,org=30000,window=60",
    "ip=600;user=600;org=30000;window=60",
    "IP=600,USER=600,ORG=30000,WINDOW=60",
    "ip=600,user=600,org=30000,window=60,",
  ])("%j is refused", (text) => {
    expect(parseRateLimit(text)).toBeUndefined();
  });

  it("an override changes its class alone", () => {
    const config = loadApiConfig({
      ...devApiEnv,
      RATE_LIMIT_AUTH_ADJACENT: "ip=5,user=4,org=3,window=2",
    });
    expect(config.rateLimits).toEqual({
      ...RATE_LIMIT_DEFAULTS,
      auth_adjacent: { ip: 5, user: 4, org: 3, windowSeconds: 2 },
    });
    expect(Object.isFrozen(config.rateLimits.auth_adjacent)).toBe(true);
  });

  it("each class's key overrides that class", () => {
    for (const cls of RATE_LIMIT_CLASSES) {
      const config = loadApiConfig({
        ...devApiEnv,
        [RATE_LIMIT_ENV_KEYS[cls]]: "ip=7,user=8,org=9,window=10",
      });
      expect(config.rateLimits[cls], cls).toEqual({
        ip: 7,
        user: 8,
        org: 9,
        windowSeconds: 10,
      });
    }
  });

  it("an empty value is unset: the default", () => {
    expect(
      loadApiConfig({ ...devApiEnv, RATE_LIMIT_DEFAULT: "" }).rateLimits
        .default,
    ).toEqual(RATE_LIMIT_DEFAULTS.default);
  });

  it("a bad value is one problem naming the key, never the value", () => {
    const env = {
      ...devApiEnv,
      RATE_LIMIT_EXPORT: "ip=secret-value-42,user=1,org=1,window=1",
    };
    expect(problemsOf(() => loadApiConfig(env))).toEqual([
      "RATE_LIMIT_EXPORT:invalid_format",
    ]);
    expect(messageOf(() => loadApiConfig(env))).not.toContain(
      "secret-value-42",
    );
  });
});

describe("TRUST_PROXY", () => {
  it("unset or off: no proxy is trusted (request.ip is the socket peer)", () => {
    expect(loadApiConfig(devApiEnv).trustProxy).toEqual({ mode: "off" });
    expect(
      loadApiConfig({ ...devApiEnv, TRUST_PROXY: "off" }).trustProxy,
    ).toEqual({ mode: "off" });
    expect(fastifyTrustProxy({ mode: "off" })).toBe(false);
  });

  it("hops:N trusts the last N hops (1-3)", () => {
    for (const hops of [1, 2, 3]) {
      const parsed = parseTrustProxy(`hops:${String(hops)}`);
      expect(parsed).toEqual({ mode: "hops", hops });
      expect(parsed && fastifyTrustProxy(parsed)).toBe(hops);
    }
    expect(loadApiConfig(prodApiEnv).trustProxy).toEqual({
      mode: "hops",
      hops: 2,
    });
  });

  it("a CIDR list trusts those networks (IPv4 and IPv6)", () => {
    const parsed = parseTrustProxy("10.0.0.0/16,10.1.0.0/16,fd00::/8");
    expect(parsed).toEqual({
      mode: "cidrs",
      cidrs: ["10.0.0.0/16", "10.1.0.0/16", "fd00::/8"],
    });
    expect(parsed && fastifyTrustProxy(parsed)).toEqual([
      "10.0.0.0/16",
      "10.1.0.0/16",
      "fd00::/8",
    ]);
    expect(parseTrustProxy("127.0.0.1/32")).toEqual({
      mode: "cidrs",
      cidrs: ["127.0.0.1/32"],
    });
  });

  it.each([
    "true",
    "TRUE",
    "1",
    "*",
    "yes",
    "hops:0",
    "hops:4",
    "hops:-1",
    "hops:two",
    "10.0.0.0",
    "10.0.0.0/33",
    "300.0.0.0/8",
    "fd00::/129",
    "10.0.0.0/16,",
    "10.0.0.0/16, 10.1.0.0/16",
    "0.0.0.0/0",
    "::/0",
    "loopback",
  ])("%j is refused", (text) => {
    expect(parseTrustProxy(text)).toBeUndefined();
    expect(
      problemsOf(() => loadApiConfig({ ...devApiEnv, TRUST_PROXY: text })),
    ).toEqual(["TRUST_PROXY:invalid_format"]);
  });

  it("production refuses it unset or off", () => {
    expect(problemsOf(() => loadApiConfig(prodApiEnv))).toEqual([]);
    expect(
      problemsOf(() => loadApiConfig(without(prodApiEnv, "TRUST_PROXY"))),
    ).toEqual(["TRUST_PROXY:required_in_production"]);
    expect(
      problemsOf(() => loadApiConfig({ ...prodApiEnv, TRUST_PROXY: "off" })),
    ).toEqual(["TRUST_PROXY:required_in_production"]);
    expect(
      problemsOf(() => loadApiConfig({ ...prodApiEnv, TRUST_PROXY: "true" })),
    ).toEqual(["TRUST_PROXY:invalid_format"]);
  });
});

describe("reads only declared keys", () => {
  it("never enumerates the environment", () => {
    const read: string[] = [];
    const env = new Proxy(
      { ...devApiEnv, RATE_LIMIT_SOMETHING_ELSE: "x" },
      {
        get(target, key, receiver) {
          if (typeof key === "string") read.push(key);
          return Reflect.get(target, key, receiver) as unknown;
        },
        ownKeys() {
          throw new Error("the loader must not enumerate the environment");
        },
      },
    );
    loadApiConfig(env);
    expect(read).not.toContain("RATE_LIMIT_SOMETHING_ELSE");
    expect(new Set(read)).toEqual(new Set(apiKeys));
  });
});
