// P4-01: the built entry point, as `pnpm --filter @bricx/api start` runs
// it (node --import register.js main.js, no env file). Bad config exits 1
// naming keys only; a good one serves /health/ready on API_PORT; SIGTERM
// shuts down cleanly: Nest's shutdown hooks close the probes, then re-raise
// the signal, so the process ends by SIGTERM (exit status 143 in a shell).
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { waitFor } from "@bricx/db-bootstrap/stack";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { exampleValue } from "./env.js";
import { type Stack, startStack } from "./stack.js";

const appDir = path.resolve(import.meta.dirname, "..");
// The real build (`pnpm --filter @bricx/api build`): dist/ resolves the
// workspace packages through apps/api/node_modules, as `start` does.
const outDir = path.join(appDir, "dist");
let stack: Stack;
beforeAll(async () => {
  execFileSync(
    process.execPath,
    [tscPath(), "-p", path.join(appDir, "tsconfig.build.json")],
    {
      cwd: appDir,
      stdio: "pipe",
    },
  );
  stack = await startStack();
});
afterAll(async () => {
  await stack.stop();
});

/** The workspace's TypeScript compiler (a root devDependency). */
function tscPath(): string {
  return path.resolve(appDir, "../../node_modules/typescript/bin/tsc");
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === "string")
    throw new Error("no port");
  return address.port;
}

interface Run {
  child: ChildProcess;
  output: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function run(env: Record<string, string>): Run {
  const child = spawn(
    process.execPath,
    [
      "--import",
      path.join(outDir, "register.js"),
      path.join(outDir, "main.js"),
    ],
    {
      cwd: appDir,
      env: { PATH: process.env.PATH ?? "", ...env },
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
    child.on("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
  return { child, output: () => out, exited };
}

describe("the built entry point", () => {
  test("a missing and an invalid key exit 1 naming keys only, before Nest starts", async () => {
    const rest = Object.fromEntries(
      Object.entries(stack.env()).filter(([key]) => key !== "DATABASE_URL"),
    );
    const sentinel = "sentinel-not-a-port-91";
    const r = run({ ...rest, API_PORT: sentinel });
    expect(await r.exited).toEqual({ code: 1, signal: null });
    const out = r.output();
    expect(out).toContain("DATABASE_URL: missing");
    expect(out).toContain("API_PORT");
    expect(out).not.toContain(sentinel);
    expect(out).not.toContain(exampleValue("VALKEY_PASSWORD"));
    expect(out).not.toContain("NestFactory");
    expect(out).not.toContain("Nest application");
  });

  test("a valid environment serves /health/ready on API_PORT; SIGTERM closes the probes and ends the process", async () => {
    const port = await freePort();
    const r = run(stack.env({ API_PORT: String(port) }));
    try {
      const body = await waitFor(
        "the API to answer",
        async () => {
          const res = await fetch(
            `http://127.0.0.1:${String(port)}/health/ready`,
          );
          return res.status === 200 ? await res.json() : undefined;
        },
        60_000,
      );
      expect(body).toMatchObject({ status: "ok" });
    } finally {
      r.child.kill("SIGTERM");
    }
    expect(await r.exited).toEqual({ code: null, signal: "SIGTERM" });
    expect(r.output()).toContain("readiness probes closed");
    expect(r.output()).not.toContain(exampleValue("BRICX_APP_PASSWORD"));
  });
});
