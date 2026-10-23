// P4-03: the request context. A Fastify onRequest hook creates the store
// (AsyncLocalStorage.run), the auth guard sets the identity (P5-02: from a
// real token, test/support/auth.ts), the interceptor validates and freezes
// it, and handlers read it. Parallel requests never see each other's
// context. No database: the user directory is fixed and the TxRunner
// refusals happen before withTx(); test/context.int.test.ts runs it
// against Postgres. P5-05 (ADR 0066, owner condition 2): the identity's
// allProjects is sealed as a boolean and reaches withTx() as the typed
// option alone (never as a project id); with project ids it is invalid.
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { loadApiConfig } from "@bricx/config/api";
import type { Database, TxContext } from "@bricx/db/database";
import { Body, Controller, Get, HttpCode, Inject, Post } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import type { Access, GrantsSource } from "../src/common/auth/grants-source.js";
import { Public } from "../src/common/auth/public.decorator.js";
import {
  currentRequestContext,
  setIdentity,
} from "../src/common/db/request-context.js";
import { TxRunner } from "../src/common/db/tx-runner.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";
import {
  fixedRevocations,
  TestIssuer,
  fixedSessions,
  bearer,
  fixedAccess,
  fixedUsers,
  grantsOf,
  roleGrants,
} from "./support/auth.js";

const ORG = "0199e1a0-0000-7000-8000-00000000000a";
const USER = "0199e1a0-0000-7000-8000-000000000001";
const PROJECT = "0199e1a0-0000-7000-8000-000000000010";
const DEVICE = "0199e1a0-0000-7000-8000-0000000000de";
const SESSION = "0199e1a0-0000-7000-8000-00000000005e";

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
class ContextController {
  constructor(@Inject(TxRunner) private readonly runner: TxRunner) {}

  @Get()
  get() {
    return snapshot();
  }

  @Get("anon")
  @Public()
  anon() {
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
  @Public()
  mutate() {
    const ctx = currentRequestContext();
    return {
      setIdentity: errorName(() => {
        setIdentity({
          orgId: ORG,
          userId: USER,
          projectIds: [],
          allProjects: false,
          grants: [],
          membershipGrants: [],
          sessionId: SESSION,
          deviceId: undefined,
        });
      }),
      // Reflect.set returns false instead of throwing on a frozen object.
      assigned:
        ctx === undefined ? null : Reflect.set(ctx, "correlationId", "forged"),
      correlationId: ctx?.correlationId,
    };
  }

  @Get("tx")
  @Public()
  async tx() {
    try {
      await this.runner.run(() => Promise.resolve("unreachable"));
      return { error: null };
    } catch (error) {
      return { error: error instanceof Error ? error.name : "non-error" };
    }
  }

  /** Runs one transaction as the identity; the fake database records the context. */
  @Get("tx-context")
  async txContext() {
    return this.runner.run(() => Promise.resolve({ ran: true }));
  }
}

/** A database that runs no SQL: it records each withTx() context. */
function recordingDatabase(): Database & { contexts: TxContext[] } {
  const contexts: TxContext[] = [];
  return {
    contexts,
    ping: () => Promise.resolve(),
    withTx: (context, fn) => {
      contexts.push(context);
      return fn(undefined as never);
    },
    close: () => Promise.resolve(),
  };
}

let issuer: TestIssuer;
beforeAll(async () => {
  issuer = await TestIssuer.start();
});
afterAll(async () => {
  await issuer.close();
});

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const MANAGER = { projects: [PROJECT], roles: ["project_manager"] } as const;

async function start(
  grantsSource: GrantsSource = roleGrants({ [USER]: MANAGER }),
  database?: Database,
): Promise<NestFastifyApplication> {
  app = await createApp(loadApiConfig(apiEnv(issuer.env())), {
    probes: fakeProbes(),
    revocationStore: fixedRevocations(),
    extraControllers: [ContextController],
    userDirectory: fixedUsers({}, USER),
    sessionTracker: fixedSessions({ sessionId: SESSION, devices: [DEVICE] }),
    grantsSource,
    ...(database === undefined ? {} : { database }),
  });
  await app.init();
  return app;
}

/** A token for USER in `org`. */
const tokenFor = (org: string) =>
  issuer.token({ sub: "ctx-user", org_id: org });

describe("the request context", () => {
  test("is created per request: correlation id, ip, device id; no identity on a public route", async () => {
    const app = await start();
    const res = await app.inject({
      method: "GET",
      url: "/v1/ctx/anon",
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
        url: "/v1/ctx/anon",
        headers: { "x-device-id": bad },
      });
      expect(res.json<{ deviceId: unknown }>().deviceId).toBeNull();
    }
  });

  test("the guard-set identity is visible, validated and frozen in the handler", async () => {
    const app = await start();
    const res = await app.inject({
      method: "GET",
      url: "/v1/ctx",
      headers: { "x-request-id": "req-2", ...bearer(await tokenFor(ORG)) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      correlationId: "req-2",
      identity: {
        orgId: ORG,
        userId: USER,
        projectIds: [PROJECT],
        allProjects: false,
        grants: JSON.parse(JSON.stringify(grantsOf(MANAGER))) as unknown,
        sessionId: SESSION,
      },
      frozen: true,
      identityFrozen: true,
    });
  });

  describe("allProjects (P5-05, owner condition 2)", () => {
    const orgWide: Access = {
      projectIds: [],
      grants: [{ permission: "project.milestone.read", scope: "org" }],
      membershipGrants: [
        { permission: "project.milestone.read", scope: "org" },
      ],
      allProjects: true,
    };

    test("is sealed as true with no project ids, and reaches withTx() as the typed option", async () => {
      const database = recordingDatabase();
      const app = await start(fixedAccess(orgWide), database);
      const res = await app.inject({
        method: "GET",
        url: "/v1/ctx",
        headers: bearer(await tokenFor(ORG)),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        identity: { projectIds: [], allProjects: true },
        identityFrozen: true,
      });
      const tx = await app.inject({
        method: "GET",
        url: "/v1/ctx/tx-context",
        headers: bearer(await tokenFor(ORG)),
      });
      expect(tx.statusCode).toBe(200);
      expect(database.contexts).toEqual([
        { orgId: ORG, userId: USER, projectIds: [], allProjects: true },
      ]);
    });

    test("a member without it: sealed as false, and withTx() gets the project ids and no option", async () => {
      const database = recordingDatabase();
      const app = await start(undefined, database);
      const tx = await app.inject({
        method: "GET",
        url: "/v1/ctx/tx-context",
        headers: bearer(await tokenFor(ORG)),
      });
      expect(tx.statusCode).toBe(200);
      expect(database.contexts).toEqual([
        { orgId: ORG, userId: USER, projectIds: [PROJECT], allProjects: false },
      ]);
    });

    test.each([
      ["with project ids", { ...orgWide, projectIds: [PROJECT] }],
      [
        "membership grants that are not valid grants (PR #71 review, amendment 3)",
        {
          ...orgWide,
          membershipGrants: [
            JSON.parse(
              '{"permission":"project.milestone.read","scope":"everything"}',
            ) as never,
          ],
        },
      ],
      [
        "not a boolean",
        JSON.parse(
          JSON.stringify({ ...orgWide, allProjects: "yes" }),
        ) as Access,
      ],
      [
        "the wildcard as a project id",
        {
          projectIds: ["*"],
          grants: [],
          membershipGrants: [],
          allProjects: false,
        },
      ],
    ])(
      "%s: an invalid identity, 500 before the handler",
      async (_what, access) => {
        const database = recordingDatabase();
        const app = await start(fixedAccess(access), database);
        const res = await app.inject({
          method: "GET",
          url: "/v1/ctx/tx-context",
          headers: bearer(await tokenFor(ORG)),
        });
        expect(res.statusCode).toBe(500);
        expect(database.contexts).toEqual([]);
      },
    );
  });

  test("an invalid identity (bad project ids from the grants source) fails the request before the handler (500, no detail)", async () => {
    const app = await start(
      fixedAccess({
        projectIds: ["org-1'; DROP TABLE x"],
        grants: [],
        membershipGrants: [],
        allProjects: false,
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: "/v1/ctx",
      headers: bearer(await tokenFor(ORG)),
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
    const tokens = await Promise.all(orgs.map(tokenFor));
    const gets = orgs.map((_org, i) =>
      app.inject({
        method: "GET",
        url: "/v1/ctx/delayed",
        headers: {
          "x-request-id": `par-${String(i).padStart(2, "0")}`,
          ...bearer(tokens[i] ?? ""),
        },
      }),
    );
    const posts = orgs.map((_org, i) =>
      app.inject({
        method: "POST",
        url: "/v1/ctx",
        headers: {
          "x-request-id": `post-${String(i)}`,
          ...bearer(tokens[i] ?? ""),
        },
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
    const post = (i: number, token: string) =>
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
                ...bearer(token),
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
    const tokens = await Promise.all(orgs.map(tokenFor));
    const results = await Promise.all(
      orgs.map((_org, i) => post(i, tokens[i] ?? "")),
    );
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
        setIdentity({
          orgId: ORG,
          userId: USER,
          projectIds: [],
          allProjects: false,
          grants: [],
          membershipGrants: [],
          sessionId: SESSION,
          deviceId: undefined,
        });
      }),
    ).toBe("NoRequestContextError");
  });
});

describe("TxRunner refusals (before any connection)", () => {
  test("a request without an identity (a public route): NoTenantContextError", async () => {
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
