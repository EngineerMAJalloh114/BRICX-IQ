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
import { Controller, Get, Post } from "@nestjs/common";
import { PUBLIC_EXTENSION } from "../src/common/auth/public.decorator.js";
import {
  REGISTERS_DEVICE_EXTENSION,
  RegistersDevice,
} from "../src/common/auth/registers-device.decorator.js";
import { buildOpenApiDocument } from "../src/openapi/document.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";
import {
  TestIssuer,
  bearer,
  fixedSessions,
  fixedUsers,
  roleGrants,
} from "./support/auth.js";

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

// Two test routes beside the production controllers: a plain one and
// one marked @RegistersDevice(), so the mechanics are proven even while
// the production document has no non-public operation (before commit 6).
const TEST_ROUTE = "/v1/device-probe";
@Controller({ path: "device-probe", version: "1" })
class DeviceProbeController {
  @Get()
  plain() {
    return { ok: true };
  }

  @Post("register")
  @RegistersDevice()
  register() {
    return { ok: true };
  }
}

describe("an unregistered X-Device-Id (P5-03, ADR 0063, owner condition 4)", () => {
  const USER = "0199e1a0-0000-7000-8000-000000000001";
  const ORG = "0199e1a0-0000-7000-8000-00000000000a";
  const UNREGISTERED = "0199e1a0-0000-7000-8000-0000000000d0";
  let issuer: TestIssuer;
  let guarded: NestFastifyApplication;
  let tracker: ReturnType<typeof fixedSessions>;
  beforeAll(async () => {
    issuer = await TestIssuer.start();
    // The production controllers plus the probe, a fixed user, no
    // registered device.
    tracker = fixedSessions({ devices: [] });
    guarded = await createApp(loadApiConfig(apiEnv(issuer.env())), {
      probes: fakeProbes(),
      userDirectory: fixedUsers({}, USER),
      sessionTracker: tracker,
      grantsSource: roleGrants(),
      extraControllers: [DeviceProbeController],
    });
    await guarded.init();
  });
  afterAll(async () => {
    await guarded.close();
    await issuer.close();
  });

  test("only the operations marked x-bricx-registers-device accept it; before P5-03's endpoints that production set is empty, and every other non-public operation is 401 device_unknown", async () => {
    const doc = buildOpenApiDocument(guarded);
    const paths = doc.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const registering: string[] = [];
    const checked: string[] = [];
    const token = await issuer.token({ sub: "device-user", org_id: ORG });
    for (const [route, item] of Object.entries(paths)) {
      for (const method of METHODS) {
        const op = item[method];
        if (op === undefined || op[PUBLIC_EXTENSION] === true) continue;
        if (op[REGISTERS_DEVICE_EXTENSION] === true) {
          registering.push(`${method} ${route}`);
          continue;
        }
        const before = tracker.tracked.length;
        const res = await guarded.inject({
          method: method.toUpperCase() as "GET",
          url: route.replace(/\{[^}]+\}/g, SAMPLE_ID),
          headers: {
            ...bearer(token),
            "x-device-id": UNREGISTERED,
            "content-type": "application/json",
          },
          ...(method === "get" || method === "delete" ? {} : { payload: "{}" }),
        });
        expect(res.statusCode, `${method} ${route}`).toBe(401);
        expect(res.json(), `${method} ${route}`).toMatchObject({
          code: "unauthenticated",
        });
        // The tracker saw the device and refused it: the guard never
        // bypassed the check for this route.
        expect(tracker.tracked.slice(before)).toEqual([
          expect.objectContaining({
            deviceId: UNREGISTERED,
            registersDevice: false,
          }),
        ]);
        checked.push(`${method} ${route}`);
      }
    }
    expect(checked).toContain(`get ${TEST_ROUTE}`);
    expect(registering).toEqual([`post ${TEST_ROUTE}/register`]);
    // The production set: no operation registers a device yet.
    expect(registering.filter((r) => !r.includes(TEST_ROUTE))).toEqual([]);
  });

  test("a route marked @RegistersDevice() hands the header to the tracker as a registration, nothing else changes", async () => {
    const before = tracker.tracked.length;
    const res = await guarded.inject({
      method: "POST",
      url: `${TEST_ROUTE}/register`,
      headers: {
        ...bearer(await issuer.token({ sub: "device-user", org_id: ORG })),
        "x-device-id": UNREGISTERED,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(tracker.tracked.slice(before)).toEqual([
      expect.objectContaining({
        deviceId: UNREGISTERED,
        registersDevice: true,
      }),
    ]);
  });

  test("the marked route still refuses a malformed header", async () => {
    const res = await guarded.inject({
      method: "POST",
      url: `${TEST_ROUTE}/register`,
      headers: {
        ...bearer(await issuer.token({ sub: "device-user", org_id: ORG })),
        "x-device-id": "not-a-uuid",
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "unauthenticated" });
  });
});
