// The API's adapter registry at boot (P6-04, ADR 0074; Done when 3, owner
// conditions C2 and C5): createApp() builds it first, for the validated
// config's nodeEnv, and provides the frozen result under ADAPTER_REGISTRY.
// - the dev registry: the five Null adapters, and the app starts;
// - a broken list (the test-only `adapters` option) refuses to start with
//   AdapterRegistryError, before any pool is opened;
// - production with no list: an empty registry, and the app starts;
//   production with a Null adapter: refused;
// - the list comes from the factory option or defaultAdapters(), never
//   from an environment variable: NODE_ENV in process.env changes nothing.
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  type AdapterRegistry,
  AdapterRegistryError,
  defaultAdapters,
} from "@bricx/adapters/registry";
import { nullPayment } from "@bricx/adapters/null";
import { ADAPTER_KINDS, type AdapterDescriptor } from "@bricx/adapters/types";
import { type ApiConfig, loadApiConfig } from "@bricx/config/api";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { ADAPTER_REGISTRY } from "../src/common/adapters/adapters.module.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";
import { fixedRevocations } from "./support/auth.js";

const config = loadApiConfig(apiEnv({ NODE_ENV: "test" }));
const production: ApiConfig = { ...config, nodeEnv: "production" };

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  await app?.close();
  app = undefined;
});

const start = async (cfg: ApiConfig) => {
  app = await createApp(cfg, {
    probes: fakeProbes(),
    revocationStore: fixedRevocations(),
  });
  return app.get<symbol, AdapterRegistry>(ADAPTER_REGISTRY);
};

const refusal = async (
  cfg: ApiConfig,
  adapters: readonly AdapterDescriptor[],
): Promise<unknown> =>
  createApp(cfg, {
    probes: fakeProbes(),
    revocationStore: fixedRevocations(),
    adapters,
  }).then(
    async (built) => {
      await built.close();
      return undefined;
    },
    (error: unknown) => error,
  );

describe("createApp() and the adapter registry", () => {
  test("the dev registry: the five Null adapters, frozen, for config.nodeEnv", async () => {
    const registry = await start(config);
    expect(registry.nodeEnv).toBe("test");
    expect(Object.isFrozen(registry)).toBe(true);
    for (const kind of ADAPTER_KINDS) {
      expect(registry.list(kind).map((a) => a.id)).toEqual([`null_${kind}`]);
    }
  });

  test("a broken list refuses to start: AdapterRegistryError with a code and an index", async () => {
    const error = await refusal(config, [nullPayment, nullPayment]);
    expect(error).toBeInstanceOf(AdapterRegistryError);
    expect(error).toMatchObject({ code: "duplicate_id", index: 1 });
  });

  test("an unknown country refuses to start too, naming no value", async () => {
    const error = await refusal(config, [
      { ...nullPayment, id: "pay_q", countries: ["QQ"] },
    ]);
    expect(error).toMatchObject({ code: "unknown_country", index: 0 });
    expect((error as Error).message).not.toContain("QQ");
  });

  test("production with no list: an empty registry, and the app starts", async () => {
    const registry = await start(production);
    expect(registry.nodeEnv).toBe("production");
    for (const kind of ADAPTER_KINDS) {
      expect(registry.list(kind)).toEqual([]);
    }
  });

  test("production refuses a Null adapter", async () => {
    const error = await refusal(production, defaultAdapters("test"));
    expect(error).toMatchObject({ code: "null_in_production", index: 0 });
  });

  test("NODE_ENV in process.env changes nothing: config.nodeEnv decides (C2)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const registry = await start(config);
    expect(registry.nodeEnv).toBe("test");
    expect(registry.has("payment", "null_payment")).toBe(true);
  });

  test("app.ts reads no environment variable for the registry; bootstrap.ts sets no adapters option", () => {
    const src = path.resolve(import.meta.dirname, "../src");
    const appSource = readFileSync(path.join(src, "app.ts"), "utf8");
    expect(appSource).toContain(
      "options.adapters ?? defaultAdapters(config.nodeEnv)",
    );
    expect(appSource).toContain("{ nodeEnv: config.nodeEnv }");
    expect(appSource).not.toMatch(/process\.env/);
    const bootstrap = readFileSync(path.join(src, "bootstrap.ts"), "utf8");
    expect(bootstrap).not.toMatch(/adapters/);
  });
});
