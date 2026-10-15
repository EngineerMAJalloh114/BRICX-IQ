// P4-01: /health/ready against the real dev-stack images. Each dependency
// is paused alone: ready turns 503 naming only it, within a bound (the
// probes time out; a paused peer never answers), and 200 again once it is
// unpaused. Closing the app releases its Postgres connections.
import { pause, unpause } from "@bricx/db-bootstrap/s3";
import { waitFor } from "@bricx/db-bootstrap/stack";
import { loadApiConfig } from "@bricx/config/api";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { type Stack, startStack } from "./stack.js";

let stack: Stack;
let app: NestFastifyApplication;
beforeAll(async () => {
  stack = await startStack();
  app = await createApp(loadApiConfig(stack.env()));
  await app.init();
});
afterAll(async () => {
  await app.close().catch(() => undefined);
  await stack.stop();
});

async function ready() {
  const res = await app.inject({ method: "GET", url: "/health/ready" });
  return { status: res.statusCode, body: res.json<Record<string, unknown>>() };
}

async function appConnections(): Promise<number> {
  const admin = await stack.postgres.admin();
  try {
    const r = await admin.query<{ n: string }>(
      "SELECT count(*) AS n FROM pg_stat_activity WHERE usename = 'bricx_app'",
    );
    return Number(r.rows[0]?.n ?? "-1");
  } finally {
    await admin.end();
  }
}

describe("/health/ready against the dev stack", () => {
  test("is 200 with db, valkey and s3 up", async () => {
    const res = await ready();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      info: {
        db: { status: "up" },
        valkey: { status: "up" },
        s3: { status: "up" },
      },
    });
    const text = JSON.stringify(res.body);
    for (const secret of ["dev-only", "bricx_app", "redis://", "postgres://"]) {
      expect(text).not.toContain(secret);
    }
  });

  const cases: [string, () => StartedTestContainer][] = [
    ["db", () => stack.postgres.container],
    ["valkey", () => stack.valkey],
    ["s3", () => stack.s3],
  ];
  test.each(cases)(
    "is 503 naming only %s while it is paused, then 200",
    async (name, container) => {
      await pause(container());
      try {
        const started = performance.now();
        const down = await ready();
        expect(performance.now() - started).toBeLessThan(15_000);
        expect(down.status).toBe(503);
        expect(down.body).toMatchObject({
          status: "error",
          error: { [name]: { status: "down" } },
        });
        expect(Object.keys(down.body.error as object)).toEqual([name]);
      } finally {
        await unpause(container());
      }
      await waitFor(
        "ready to recover",
        async () => ((await ready()).status === 200 ? true : undefined),
        60_000,
      );
    },
  );

  test("closing the app releases its Postgres connections", async () => {
    expect((await ready()).status).toBe(200);
    expect(await appConnections()).toBeGreaterThan(0);
    await app.close();
    await waitFor(
      "connections to close",
      async () => ((await appConnections()) === 0 ? true : undefined),
      10_000,
    );
  });
});
