// P4-03: the request context. A Fastify onRequest hook creates the store
// (AsyncLocalStorage.run), a guard may set the identity (P5's auth guard
// will), the interceptor validates and freezes it, and handlers read it.
// Parallel requests never see each other's context. No database: the
// TxRunner refusals happen before withTx(); test/context.int.test.ts runs
// it against Postgres.
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { loadApiConfig } from "@bricx/config/api";
import {
  Body,
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import {
  currentRequestContext,
  setIdentity,
} from "../src/common/db/request-context.js";
import { TxRunner } from "../src/common/db/tx-runner.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";

const ORG = "0199e1a0-0000-7000-8000-00000000000a";
const USER = "0199e1a0-0000-7000-8000-000000000001";
const PROJECT = "0199e1a0-0000-7000-8000-000000000010";
const DEVICE = "0199e1a0-0000-7000-8000-0000000000de";

/** Stands in for P5's auth guard: sets the identity from test headers. */
@Injectable()
class TestIdentityGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const headers = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>().headers;
    const org = headers["x-test-org"];
    if (org !== undefined) {
      setIdentity({
        orgId: org,
        userId: headers["x-test-user"] ?? USER,
        projectIds: (headers["x-test-projects"] ?? "")
          .split(",")
          .filter(Boolean),
        roles: ["project_manager"],
      });
    }
    return true;
  }
}

function snapshot() {
  const ctx = currentRequestContext();
  return ctx === undefined
    ? { missing: true }
    : {
        correlationId: ctx.correlationId,
        ip: ctx.ip,
        deviceId: ctx.deviceId ?? null,
        geo: ctx.geo ?? null,
        identity: ctx.identity ?? null,
        frozen: Object.isFrozen(ctx),
        identityFrozen:
          ctx.identity === undefined ? null : Object.isFrozen(ctx.identity),
      };
}

const errorName = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.name : "non-error";
  }
  return "no error";
};

@Controller({ path: "ctx", version: "1" })
@UseGuards(TestIdentityGuard)
class ContextController {
  constructor(@Inject(TxRunner) private readonly runner: TxRunner) {}

  @Get()
  get() {
    return snapshot();
  }

  @Get("delayed")
  async delayed() {
    const before = snapshot();
    // Interleave with the other requests before reading again.
    await sleep(Number(currentRequestContext()?.correlationId.slice(-2)) % 7);
    await Promise.resolve();
    return { before, after: snapshot() };
  }

  @Post()
  @HttpCode(200)
  async post(@Body() body: { n: number }) {
    await sleep(1);
    return { n: body.n, ...snapshot() };
  }

  @Get("mutate")
  mutate() {
    const ctx = currentRequestContext();
    return {
      setIdentity: errorName(() => {
        setIdentity({
          orgId: ORG,
          userId: USER,
          projectIds: [],
          roles: [],
        });
      }),
      // Reflect.set returns false instead of throwing on a frozen object.
      assigned:
        ctx === undefined ? null : Reflect.set(ctx, "correlationId", "forged"),
      correlationId: ctx?.correlationId,
    };
  }

  @Get("tx")
  async tx() {
    try {
      await this.runner.run(() => Promise.resolve("unreachable"));
      return { error: null };
    } catch (error) {
      return { error: error instanceof Error ? error.name : "non-error" };
    }
  }
}

const config = loadApiConfig(apiEnv());

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(): Promise<NestFastifyApplication> {
  app = await createApp(config, {
    probes: fakeProbes(),
    extraControllers: [ContextController],
    extraProviders: [TestIdentityGuard],
  });
  await app.init();
  return app;
}

describe("the request context", () => {
  test("is created per request: correlation id, ip, device id; no identity without the guard", async () => {
    const app = await start();
    const res = await app.inject({
      method: "GET",
      url: "/v1/ctx",
      headers: { "x-request-id": "req-1", "x-device-id": DEVICE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      correlationId: "req-1",
      ip: "127.0.0.1",
      deviceId: DEVICE,
      geo: null,
      identity: null,
      frozen: true,
      identityFrozen: null,
    });
  });

  test("an invalid device id is dropped, never kept", async () => {
    const app = await start();
    for (const bad of ["not-a-uuid", DEVICE.toUpperCase(), `${DEVICE},x`]) {
      const res = await app.inject({
        method: "GET",
        url: "/v1/ctx",
        headers: { "x-device-id": bad },
      });
      expect(res.json<{ deviceId: unknown }>().deviceId).toBeNull();
    }
  });

  test("a guard-set identity is visible, validated and frozen in the handler", async () => {
    const app = await start();
    const res = await app.inject({
      method: "GET",
      url: "/v1/ctx",
      headers: {
        "x-request-id": "req-2",
        "x-test-org": ORG,
        "x-test-projects": PROJECT,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      correlationId: "req-2",
      identity: {
        orgId: ORG,
        userId: USER,
        projectIds: [PROJECT],
        roles: ["project_manager"],
      },
      frozen: true,
      identityFrozen: true,
    });
  });

  test("an invalid guard-set identity fails the request before the handler (500, no detail)", async () => {
    const app = await start();
    const res = await app.inject({
      method: "GET",
      url: "/v1/ctx",
      headers: { "x-test-org": "org-1'; DROP TABLE x" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("DROP TABLE");
    expect(res.body).not.toContain("orgId");
  });

  test("in the handler the context can no longer change", async () => {
    const app = await start();
    const res = await app.inject({
      method: "GET",
      url: "/v1/ctx/mutate",
      headers: { "x-request-id": "req-3" },
    });
    expect(res.json()).toEqual({
      setIdentity: "RequestContextSealedError",
      assigned: false,
      correlationId: "req-3",
    });
  });

  test("parallel requests stay isolated (GET with interleaving, POST with a body)", async () => {
    const app = await start();
    const orgs = Array.from(
      { length: 24 },
      (_, i) => `0199e1a0-0000-7000-8000-${String(i).padStart(12, "0")}`,
    );
    const gets = orgs.map((org, i) =>
      app.inject({
        method: "GET",
        url: "/v1/ctx/delayed",
        headers: {
          "x-request-id": `par-${String(i).padStart(2, "0")}`,
          "x-test-org": org,
        },
      }),
    );
    const posts = orgs.map((org, i) =>
      app.inject({
        method: "POST",
        url: "/v1/ctx",
        headers: { "x-request-id": `post-${String(i)}`, "x-test-org": org },
        payload: { n: i },
      }),
    );
    const getResults = await Promise.all(gets);
    getResults.forEach((res, i) => {
      const body = res.json<{
        before: { correlationId: string; identity: { orgId: string } };
        after: { correlationId: string; identity: { orgId: string } };
      }>();
      for (const seen of [body.before, body.after]) {
        expect(seen.correlationId).toBe(`par-${String(i).padStart(2, "0")}`);
        expect(seen.identity.orgId).toBe(orgs[i]);
      }
    });
    const postResults = await Promise.all(posts);
    postResults.forEach((res, i) => {
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        n: i,
        correlationId: `post-${String(i)}`,
        identity: { orgId: orgs[i] },
      });
    });
  });

  test("a body sent in chunks over a real socket keeps each request's context", async () => {
    const app = await start();
    await app.listen(0, "127.0.0.1");
    const { port } = app.getHttpServer().address() as AddressInfo;
    // Each body arrives in two packets, the second after the other
    // requests have started, so body parsing runs from socket events.
    const post = (i: number, org: string) =>
      new Promise<{ status: number | undefined; body: string }>(
        (resolve, reject) => {
          const payload = JSON.stringify({ n: i });
          const req = request(
            {
              host: "127.0.0.1",
              port,
              method: "POST",
              path: "/v1/ctx",
              headers: {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(payload)),
                "x-request-id": `sock-${String(i)}`,
                "x-test-org": org,
              },
            },
            (res) => {
              let body = "";
              res.setEncoding("utf8");
              res.on("data", (chunk: string) => (body += chunk));
              res.on("end", () => {
                resolve({ status: res.statusCode, body });
              });
            },
          );
          req.on("error", reject);
          req.flushHeaders();
          req.write(payload.slice(0, 3));
          void sleep(20 + (i % 4) * 10).then(() => req.end(payload.slice(3)));
        },
      );
    const orgs = Array.from(
      { length: 8 },
      (_, i) => `0199e1a0-0000-7000-8000-${String(100 + i).padStart(12, "0")}`,
    );
    const results = await Promise.all(orgs.map((org, i) => post(i, org)));
    results.forEach((res, i) => {
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        n: i,
        correlationId: `sock-${String(i)}`,
        identity: { orgId: orgs[i] },
        frozen: true,
      });
    });
  });

  test("outside a request there is no context, and setIdentity() refuses", () => {
    expect(currentRequestContext()).toBeUndefined();
    expect(
      errorName(() => {
        setIdentity({ orgId: ORG, userId: USER, projectIds: [], roles: [] });
      }),
    ).toBe("NoRequestContextError");
  });
});

describe("TxRunner refusals (before any connection)", () => {
  test("a request without an identity: NoTenantContextError", async () => {
    const app = await start();
    const res = await app.inject({ method: "GET", url: "/v1/ctx/tx" });
    expect(res.json()).toEqual({ error: "NoTenantContextError" });
  });

  test("outside a request: NoRequestContextError", async () => {
    const app = await start();
    const runner = app.get(TxRunner);
    await expect(runner.run(() => Promise.resolve(1))).rejects.toMatchObject({
      name: "NoRequestContextError",
    });
  });
});
