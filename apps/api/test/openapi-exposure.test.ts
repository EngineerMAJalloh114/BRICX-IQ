// P5-02 (plan decision D1, ADR 0062): OPENAPI_EXPOSURE decides who may
// read GET /openapi.json. public: anyone (the route is @Public());
// authenticated: the AuthGuard applies, 401 without a token and 200 with
// one; off: the route is not registered, so it is 404 even with a token.
// Production defaults to off and refuses public (packages/config tests).
// `pnpm gen:api` builds the document from the app, never through the
// route, so every mode builds the same document.
import { loadApiConfig } from "@bricx/config/api";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import {
  buildOpenApiDocument,
  serializeOpenApiDocument,
} from "../src/openapi/document.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";
import { TestIssuer, bearer, fixedUsers, roleGrants } from "./support/auth.js";

const ORG = "0199e1a0-0000-7000-8000-00000000000a";
const USER = "0199e1a0-0000-7000-8000-000000000001";

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

async function start(
  exposure: "public" | "authenticated" | "off",
): Promise<NestFastifyApplication> {
  app = await createApp(
    loadApiConfig(apiEnv({ ...issuer.env(), OPENAPI_EXPOSURE: exposure })),
    {
      probes: fakeProbes(),
      userDirectory: fixedUsers({}, USER),
      grantsSource: roleGrants(),
    },
  );
  await app.init();
  return app;
}

const getDoc = (a: NestFastifyApplication, headers = {}) =>
  a.inject({ method: "GET", url: "/openapi.json", headers });

describe("OPENAPI_EXPOSURE", () => {
  test("public: 200 without a token", async () => {
    const a = await start("public");
    const res = await getDoc(a);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ openapi: "3.1.0" });
  });

  test("authenticated: 401 unauthenticated without a token (WWW-Authenticate: Bearer), 200 with one", async () => {
    const a = await start("authenticated");
    const anon = await getDoc(a);
    expect(anon.statusCode).toBe(401);
    expect(anon.headers["www-authenticate"]).toBe("Bearer");
    expect(anon.json()).toMatchObject({ code: "unauthenticated" });
    const token = await issuer.token({ sub: "doc-reader", org_id: ORG });
    const res = await getDoc(a, bearer(token));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ openapi: "3.1.0" });
  });

  test("off: 404 not_found, with or without a token (the route is not registered)", async () => {
    const a = await start("off");
    expect((await getDoc(a)).statusCode).toBe(404);
    const token = await issuer.token({ sub: "doc-reader", org_id: ORG });
    const res = await getDoc(a, bearer(token));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "not_found" });
  });

  test("every mode builds the same document (gen:api never calls the route)", async () => {
    const texts = new Set<string>();
    for (const exposure of ["public", "authenticated", "off"] as const) {
      const a = await start(exposure);
      texts.add(serializeOpenApiDocument(buildOpenApiDocument(a)));
      await a.close();
      app = undefined;
    }
    expect(texts.size).toBe(1);
  });
});
