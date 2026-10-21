// P4-01 unit tests: the app as createApp() builds it, with fake readiness
// probes (no containers) and the log stream captured. Real dependencies
// are covered by test/health.int.test.ts.
import { Writable } from "node:stream";
import { loadApiConfig } from "@bricx/config/api";
import { isUuidV7 } from "@bricx/ids/uuid-v7";
import { Body, Controller, Get, HttpCode, Post } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterEach, describe, expect, test } from "vitest";
import { BODY_LIMIT_BYTES, createApp } from "../src/app.js";
import { Public } from "../src/common/auth/public.decorator.js";
import { apiEnv } from "./env.js";
import { type FakeProbe, fakeProbes, PROBE_SENTINEL } from "./probes.js";

/** A versioned route, only in the tests, to exercise /v1 and the body cap. */
// Public (P5-02): these routes test the app, not authentication, so
// they take no token (test/auth*.test.ts cover the guard).
@Controller({ path: "echo", version: "1" })
@Public()
class EchoController {
  @Get()
  get() {
    return { ok: true };
  }

  @Post()
  @HttpCode(200)
  post(@Body() body: unknown) {
    return { size: JSON.stringify(body).length };
  }
}

const config = loadApiConfig(apiEnv());

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(
  probes: Record<"db" | "valkey" | "s3", FakeProbe> = fakeProbes(),
) {
  const lines: string[] = [];
  const logStream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
      done();
    },
  });
  app = await createApp(config, {
    probes,
    logStream,
    extraControllers: [EchoController],
  });
  await app.init();
  return { app, probes, lines };
}

describe("health", () => {
  test("/health/live is 200 and needs no dependency", async () => {
    const probes = fakeProbes();
    probes.db.down = true;
    probes.valkey.down = true;
    probes.s3.down = true;
    const { app } = await start(probes);
    const res = await app.inject({ method: "GET", url: "/health/live" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
  });

  test("/health/ready is 200 when db, valkey and s3 are up", async () => {
    const { app } = await start();
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "ok",
      info: {
        db: { status: "up" },
        valkey: { status: "up" },
        s3: { status: "up" },
      },
    });
  });

  test.each(["db", "valkey", "s3"] as const)(
    "/health/ready is 503 when %s alone is down, and says nothing else",
    async (name) => {
      const probes = fakeProbes();
      probes[name].down = true;
      const { app, lines } = await start(probes);
      const res = await app.inject({ method: "GET", url: "/health/ready" });
      expect(res.statusCode).toBe(503);
      const body = res.json<{
        status: string;
        error: Record<string, unknown>;
      }>();
      expect(body.status).toBe("error");
      expect(body.error).toEqual({ [name]: { status: "down" } });
      expect(res.body).not.toContain(PROBE_SENTINEL);
      expect(lines.join("\n")).not.toContain(PROBE_SENTINEL);
    },
  );

  test("health routes are not versioned", async () => {
    const { app } = await start();
    const res = await app.inject({ method: "GET", url: "/v1/health/live" });
    expect(res.statusCode).toBe(404);
  });
});

describe("request id", () => {
  test("a valid x-request-id is echoed and logged", async () => {
    const { app, lines } = await start();
    const id = "client-abc_123.4";
    const res = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-request-id": id },
    });
    expect(res.headers["x-request-id"]).toBe(id);
    const logged = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(logged.some((l) => JSON.stringify(l).includes(`"${id}"`))).toBe(
      true,
    );
  });

  test("a missing x-request-id becomes a UUIDv7", async () => {
    const { app } = await start();
    const res = await app.inject({ method: "GET", url: "/health/live" });
    expect(isUuidV7(res.headers["x-request-id"])).toBe(true);
  });

  test.each([
    ["too long", "a".repeat(129)],
    ["a space", "abc def"],
    ["a newline", "abc\ndef"],
    ["a quote", 'abc"def'],
    ["empty", ""],
  ])(
    "an x-request-id with %s is replaced by a UUIDv7",
    async (_label, value) => {
      const { app } = await start();
      const res = await app.inject({
        method: "GET",
        url: "/health/live",
        // inject refuses some raw header values; send them as given.
        headers: value.includes("\n") ? {} : { "x-request-id": value },
      });
      const echoed = res.headers["x-request-id"];
      expect(echoed).not.toBe(value);
      expect(isUuidV7(echoed)).toBe(true);
    },
  );
});

describe("logging", () => {
  test("logs are JSON lines and redact credentials", async () => {
    const { app, lines } = await start();
    await app.inject({
      method: "GET",
      url: "/health/live",
      headers: {
        authorization: "Bearer sentinel-token-1",
        cookie: "sid=sentinel-cookie-2",
      },
    });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines)
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    const all = lines.join("\n");
    expect(all).not.toContain("sentinel-token-1");
    expect(all).not.toContain("sentinel-cookie-2");
  });
});

describe("security headers and CORS", () => {
  test("Helmet's headers are set", async () => {
    const { app } = await start();
    const res = await app.inject({ method: "GET", url: "/health/live" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["content-security-policy"]).toBeDefined();
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  test("an allowed origin gets CORS headers", async () => {
    const { app } = await start();
    const origin = config.http.corsOrigins[0] ?? "";
    expect(origin).not.toBe("");
    const res = await app.inject({
      method: "OPTIONS",
      url: "/v1/echo",
      headers: { origin, "access-control-request-method": "POST" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe(origin);
  });

  test("any other origin gets none", async () => {
    const { app } = await start();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/v1/echo",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
      },
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("versioning and body size", () => {
  test("routes are under /v1", async () => {
    const { app } = await start();
    expect(
      (await app.inject({ method: "GET", url: "/v1/echo" })).statusCode,
    ).toBe(200);
    expect((await app.inject({ method: "GET", url: "/echo" })).statusCode).toBe(
      404,
    );
  });

  test("a body up to the cap is accepted", async () => {
    const { app } = await start();
    const payload = JSON.stringify({ data: "x".repeat(BODY_LIMIT_BYTES - 20) });
    expect(payload.length).toBeLessThanOrEqual(BODY_LIMIT_BYTES);
    const res = await app.inject({
      method: "POST",
      url: "/v1/echo",
      headers: { "content-type": "application/json" },
      payload,
    });
    expect(res.statusCode).toBe(200);
  });

  test("a body over the cap is 413 (ADR 0047 follow-up)", async () => {
    const { app } = await start();
    const res = await app.inject({
      method: "POST",
      url: "/v1/echo",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ data: "x".repeat(BODY_LIMIT_BYTES) }),
    });
    expect(res.statusCode).toBe(413);
  });

  test("the cap is 1 MiB (P4 plan D5)", () => {
    expect(BODY_LIMIT_BYTES).toBe(1_048_576);
  });
});

describe("shutdown", () => {
  test("closing the app closes every probe once", async () => {
    const { app, probes } = await start();
    await app.close();
    expect([probes.db.closed, probes.valkey.closed, probes.s3.closed]).toEqual([
      1, 1, 1,
    ]);
  });
});
