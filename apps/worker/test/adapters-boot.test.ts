// The worker's adapter registry at boot (P6-04, ADR 0074; Done when 3,
// owner conditions C2 and C5): runWorker() builds it first, for the
// validated config's nodeEnv, before any connection. Without Docker:
// process.exit is replaced by a throw, and the log goes to a captured
// stream.
// - a broken list (the test-only `adapters` option) refuses to start like
//   the API's: worker.boot_failed with code adapter_registry, the
//   registry's code and the adapter's index, never a value; exit 1, and
//   nothing is connected;
// - production refuses a Null adapter;
// - the dev registry passes: boot goes on to Valkey (refused here, so the
//   next step's code, valkey_unavailable, proves the registry step passed);
// - NODE_ENV in process.env changes nothing: config.nodeEnv decides.
import { readFileSync } from "node:fs";
import path from "node:path";
import { defaultAdapters } from "@bricx/adapters/registry";
import { nullPayment } from "@bricx/adapters/null";
import type { AdapterDescriptor } from "@bricx/adapters/types";
import { type WorkerConfig, loadWorkerConfig } from "@bricx/config/worker";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runWorker } from "../src/relay/boot.js";
import { workerEnv } from "./env.js";

// Port 1 on loopback: nothing listens, so a connection is refused at once.
const config = loadWorkerConfig(
  workerEnv({ VALKEY_URL: "redis://:x@127.0.0.1:1/0", LOG_LEVEL: "info" }),
);
const production: WorkerConfig = { ...config, nodeEnv: "production" };

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super("process.exit");
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function boot(
  cfg: WorkerConfig,
  adapters?: readonly AdapterDescriptor[],
): Promise<{ exit: number | undefined; lines: Record<string, unknown>[] }> {
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Exit(typeof code === "number" ? code : undefined);
  });
  const lines: Record<string, unknown>[] = [];
  const logStream = {
    write(line: string) {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  };
  try {
    await runWorker(cfg, {
      logStream,
      ...(adapters === undefined ? {} : { adapters }),
    });
  } catch (error) {
    if (error instanceof Exit) return { exit: error.code, lines };
    throw error;
  }
  throw new Error("expected the worker to exit");
}

describe("runWorker() and the adapter registry", () => {
  test("a broken list refuses to start: adapter_registry, the code and the index, exit 1", async () => {
    const { exit, lines } = await boot(config, [nullPayment, nullPayment]);
    expect(exit).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 60,
      msg: "worker.boot_failed",
      code: "adapter_registry",
      registryCode: "duplicate_id",
      index: 1,
    });
  });

  test("the refusal names no value", async () => {
    const { exit, lines } = await boot(config, [
      { ...nullPayment, id: "pay_q", countries: ["SL", "QQ"] },
    ]);
    expect(exit).toBe(1);
    expect(lines[0]).toMatchObject({
      code: "adapter_registry",
      registryCode: "unknown_country",
      index: 0,
    });
    expect(JSON.stringify(lines)).not.toContain("QQ");
    expect(JSON.stringify(lines)).not.toContain("pay_q");
  });

  test("production refuses a Null adapter", async () => {
    const { exit, lines } = await boot(production, defaultAdapters("test"));
    expect(exit).toBe(1);
    expect(lines[0]).toMatchObject({
      code: "adapter_registry",
      registryCode: "null_in_production",
      index: 0,
    });
  });

  test("the dev registry passes: boot goes on to Valkey", async () => {
    const { exit, lines } = await boot(config);
    expect(exit).toBe(1);
    expect(lines.at(-1)).toMatchObject({
      msg: "worker.boot_failed",
      code: "valkey_unavailable",
    });
    expect(JSON.stringify(lines)).not.toContain("adapter_registry");
  });

  test("production with no list: the empty registry passes too", async () => {
    const { lines } = await boot(production);
    expect(lines.at(-1)).toMatchObject({ code: "valkey_unavailable" });
  });

  test("NODE_ENV in process.env changes nothing: config.nodeEnv decides (C2)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { lines } = await boot(config, defaultAdapters("test"));
    expect(lines.at(-1)).toMatchObject({ code: "valkey_unavailable" });
  });

  test("boot.ts builds the registry from config.nodeEnv, before Valkey; main.ts sets no adapters", () => {
    const src = path.resolve(import.meta.dirname, "../src");
    const boot = readFileSync(path.join(src, "relay/boot.ts"), "utf8");
    expect(boot).toContain(
      "options.adapters ?? defaultAdapters(config.nodeEnv)",
    );
    expect(boot).toContain("nodeEnv: config.nodeEnv,");
    expect(boot.indexOf("buildRegistry(")).toBeLessThan(
      boot.indexOf("openValkey("),
    );
    expect(boot).not.toMatch(/process\.env/);
    const main = readFileSync(path.join(src, "main.ts"), "utf8");
    expect(main).not.toMatch(/adapters/);
  });
});
