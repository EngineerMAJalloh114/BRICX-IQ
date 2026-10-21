// P5-02 (ADR 0062): deny by default. The production app (no test
// controllers) is built and every operation in its OpenAPI document is
// called without a token: each one is 401 unauthenticated except the
// operations marked public, and the public set is exactly the health
// routes. A module route marked @Public() fails this test. Every
// non-public operation declares the bearer security scheme. The app the
// server runs is built by bootstrap.ts with no test-only option.
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadApiConfig } from "@bricx/config/api";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { PUBLIC_EXTENSION } from "../src/common/auth/public.decorator.js";
import { buildOpenApiDocument } from "../src/openapi/document.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";

const SAMPLE_ID = "0199e1a0-0000-7000-8000-000000000001";
const METHODS = ["get", "put", "post", "delete", "patch"] as const;

let app: NestFastifyApplication;
beforeAll(async () => {
  app = await createApp(loadApiConfig(apiEnv()), { probes: fakeProbes() });
  await app.init();
});
afterAll(async () => {
  await app.close();
});

interface Operation {
  readonly method: (typeof METHODS)[number];
  readonly path: string;
  readonly body: Record<string, unknown>;
}

function operations(): Operation[] {
  const doc = buildOpenApiDocument(app);
  const paths = doc.paths as Record<string, Record<string, unknown>>;
  const out: Operation[] = [];
  for (const [route, item] of Object.entries(paths)) {
    for (const method of METHODS) {
      const body = item[method];
      if (typeof body === "object" && body !== null) {
        out.push({
          method,
          path: route,
          body: body as Record<string, unknown>,
        });
      }
    }
  }
  return out;
}

describe("every route needs a token unless it is public", () => {
  test("the public operations are exactly the health routes", () => {
    const pub = operations()
      .filter((op) => op.body[PUBLIC_EXTENSION] === true)
      .map((op) => `${op.method.toUpperCase()} ${op.path}`);
    expect(pub.sort()).toEqual(["GET /health/live", "GET /health/ready"]);
  });

  test("every other operation without a token is 401 unauthenticated with WWW-Authenticate: Bearer", async () => {
    const guarded = operations().filter(
      (op) => op.body[PUBLIC_EXTENSION] !== true,
    );
    for (const op of guarded) {
      const res = await app.inject({
        method: op.method.toUpperCase() as "GET",
        url: op.path.replaceAll(/\{[^}]+\}/g, SAMPLE_ID),
        headers: { "content-type": "application/json" },
        ...(op.method === "get" || op.method === "delete"
          ? {}
          : { payload: "{}" }),
      });
      expect(res.statusCode, `${op.method} ${op.path}`).toBe(401);
      expect(res.headers["www-authenticate"]).toBe("Bearer");
      expect(res.json()).toMatchObject({ code: "unauthenticated" });
    }
  });

  test("every non-public operation declares the bearer scheme; public ones declare none", () => {
    const doc = buildOpenApiDocument(app);
    expect((doc.components as Record<string, unknown>).securitySchemes).toEqual(
      {
        bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
    );
    for (const op of operations()) {
      if (op.body[PUBLIC_EXTENSION] === true) {
        expect(op.body.security).toBeUndefined();
      } else {
        expect(op.body.security).toEqual([{ bearer: [] }]);
      }
    }
  });

  test("the public routes answer without a token", async () => {
    for (const url of ["/health/live", "/health/ready"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
    }
  });
});

describe("bootstrap.ts", () => {
  test("builds the app from the config alone: no test-only option (user directory, grants source, clock, JWKS override)", () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, "../src/bootstrap.ts"),
      "utf8",
    );
    const calls = [...source.matchAll(/createApp\(([^)]*)\)/g)].map(
      (m) => m[1],
    );
    expect(calls).toEqual(["config"]);
  });
});
