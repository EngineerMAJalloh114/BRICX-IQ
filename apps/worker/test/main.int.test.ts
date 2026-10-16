// P4-06 (Done when 7): the built worker, as `pnpm --filter @bricx/worker
// start` runs it (node --import register.js main.js, no env file).
// - A bad environment exits 1 naming keys only, before Valkey or Postgres.
// - It refuses to start unless Valkey's maxmemory-policy is noeviction
//   (condition 4): an evicting Valkey could drop jobs the outbox already
//   marked published.
// - A good one publishes pending rows, and SIGTERM stops it gracefully:
//   the batch in flight finishes, then exit 0 with worker.stopped logged.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { waitFor } from "@bricx/db-bootstrap/stack";
import { type Database, openDatabase } from "@bricx/db/database";
import { insertOutbox } from "@bricx/db/outbox";
import { createUuidV7Generator } from "@bricx/ids/uuid-v7";
import { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { openValkey } from "../src/relay/valkey.js";
import { exampleValue, workerEnv } from "./env.js";
import { type Stack, startStack } from "./stack.js";

const appDir = path.resolve(import.meta.dirname, "..");
const outDir = path.join(appDir, "dist");
const ORG = "0199e1a0-0000-7000-8000-00000000000a";
const USER = "0199e1a0-0000-7000-8000-000000000001";
const ids = createUuidV7Generator({ clock: { now: () => Date.now() } });

let stack: Stack;
let app: Database;

beforeAll(async () => {
  // The real build (`pnpm --filter @bricx/worker build`).
  execFileSync(
    process.execPath,
    [
      path.resolve(appDir, "../../node_modules/typescript/bin/tsc"),
      "-p",
      path.join(appDir, "tsconfig.build.json"),
    ],
    { cwd: appDir, stdio: "pipe" },
  );
  stack = await startStack();
  app = openDatabase({ reveal: () => stack.url("bricx_app") });
});
afterAll(async () => {
  await app.close();
  await stack.stop();
});

const env = (overrides: Record<string, string> = {}) =>
  workerEnv({
    DATABASE_URL: stack.url("bricx_app"),
    RELAY_DATABASE_URL: stack.url("bricx_relay"),
    VALKEY_URL: stack.valkeyUrl(),
    LOG_LEVEL: "info",
    ...overrides,
  });

interface Run {
  child: ChildProcess;
  output: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function run(environment: Record<string, string>): Run {
  const child = spawn(
    process.execPath,
    [
      "--import",
      path.join(outDir, "register.js"),
      path.join(outDir, "main.js"),
    ],
    {
      cwd: appDir,
      env: { PATH: process.env.PATH ?? "", ...environment },
      stdio: "pipe",
    },
  );
  let out = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
  child.stderr.on("data", (d: Buffer) => (out += d.toString("utf8")));
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.on("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
  return { child, output: () => out, exited };
}

async function setPolicy(policy: string): Promise<void> {
  const client = openValkey({ reveal: () => stack.valkeyUrl() });
  try {
    await client.connect();
    await client.config("SET", "maxmemory-policy", policy);
  } finally {
    client.disconnect();
  }
}

describe("the built worker", () => {
  test("a missing and an invalid key exit 1 naming keys only", async () => {
    const good = env();
    const bad = Object.fromEntries(
      Object.entries({ ...good, LOG_LEVEL: "loud" }).filter(
        ([key]) => key !== "RELAY_DATABASE_URL",
      ),
    );
    const r = run(bad);
    expect(await r.exited).toEqual({ code: 1, signal: null });
    const out = r.output();
    expect(out).toContain("worker config is invalid");
    expect(out).toContain("RELAY_DATABASE_URL: missing");
    expect(out).toContain("LOG_LEVEL: invalid_value");
    for (const secret of [
      exampleValue("BRICX_APP_PASSWORD"),
      exampleValue("VALKEY_PASSWORD"),
      "loud",
    ]) {
      expect(out).not.toContain(secret);
    }
  });

  test("refuses to start unless Valkey's maxmemory-policy is noeviction (condition 4)", async () => {
    await setPolicy("allkeys-lru");
    try {
      const r = run(env());
      expect(await r.exited).toEqual({ code: 1, signal: null });
      const out = r.output();
      expect(out).toContain('"msg":"worker.boot_failed"');
      expect(out).toContain('"code":"valkey_eviction_policy"');
      expect(out).not.toContain("worker.started");
      expect(out).not.toContain(exampleValue("VALKEY_PASSWORD"));
    } finally {
      await setPolicy("noeviction");
    }
  });

  test("an unreachable relay database: exit 1, code only", async () => {
    const r = run(
      env({
        RELAY_DATABASE_URL: stack.url("bricx_relay").replace(/:\d+\//, ":1/"),
      }),
    );
    expect(await r.exited).toEqual({ code: 1, signal: null });
    expect(r.output()).toContain('"code":"database_unavailable"');
    expect(r.output()).not.toContain(exampleValue("BRICX_RELAY_PASSWORD"));
  });

  test("publishes pending rows, then SIGTERM stops it gracefully: exit 0, worker.stopped", async () => {
    const id = ids.next();
    await app.withTx({ orgId: ORG, userId: USER, projectIds: [] }, (tx) =>
      insertOutbox(tx, "system.ping", {}, id),
    );
    const inspect = new Queue("system", {
      connection: openValkey({ reveal: () => stack.valkeyUrl() }),
    });
    try {
      const r = run(env());
      await waitFor(
        "worker.started",
        () =>
          Promise.resolve(
            r.output().includes("worker.started") ? true : undefined,
          ),
        30_000,
      );
      await waitFor(
        "the job",
        async () =>
          (await inspect.getJob(id)) === undefined ? undefined : true,
        30_000,
      );
      r.child.kill("SIGTERM");
      expect(await r.exited).toEqual({ code: 0, signal: null });
      const out = r.output();
      expect(out).toContain('"msg":"worker.stopped"');
      expect(out.indexOf("worker.started")).toBeLessThan(
        out.indexOf("worker.stopped"),
      );
      for (const secret of [
        exampleValue("BRICX_RELAY_PASSWORD"),
        exampleValue("VALKEY_PASSWORD"),
      ]) {
        expect(out).not.toContain(secret);
      }
    } finally {
      await inspect.close();
    }
  });
});
