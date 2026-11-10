// P6-01 (ADR 0071; owner conditions C4 and C5): the public directory route
// GET /v1/directory/resolve, without a database (a fake reader). The
// directory_reader queries themselves run in packages/db's
// directory.int.test.ts and in directory.int.test.ts here.
// - C4: the module stands alone. Its DI graph is built from
//   @bricx/config/directory alone, and its files import nothing from the
//   cell database, withTx, the request context or provisioning;
// - C5: public (no token); exactly one of org_slug or email_domain,
//   bounded and normalised before the reader is asked, else 422; 200 is
//   { cell, apiBaseUrl, keycloakUrl } only, with a long max-age (a cell
//   never changes); 404 directory.not_found with max-age 60 and the same
//   body for both keys; an error answer is never publicly cached;
// - the route exists only when DIRECTORY_DATABASE_URL is set; the reader
//   is closed on shutdown.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { loadApiConfig } from "@bricx/config/api";
import { loadDirectoryConfig } from "@bricx/config/directory";
import { DatabaseUnavailableError } from "@bricx/db/database";
import {
  type CellRoute,
  type DirectoryLookup,
  type DirectoryReader,
  openDirectoryReader,
} from "@bricx/db/directory";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, test } from "vitest";
import { createApp } from "../../src/app.js";
import { DirectoryController } from "../../src/modules/directory/directory.controller.js";
import { DirectoryModule } from "../../src/modules/directory/public-api.js";
import { apiEnv, exampleValue } from "../env.js";
import { fakeProbes } from "../probes.js";
import { fixedRevocations } from "../support/auth.js";

const MODULE_DIR = path.join(
  import.meta.dirname,
  "../../src/modules/directory",
);
const RESOLVE = "/v1/directory/resolve";
const ACME: CellRoute = {
  cell: "af-south-1",
  apiBaseUrl: "https://api.af-south-1.bricx.invalid",
  keycloakUrl: "https://id.af-south-1.bricx.invalid/realms/bricx",
};

interface FakeReader extends DirectoryReader {
  readonly lookups: DirectoryLookup[];
  closed: number;
  failing: boolean;
}

function fakeReader(
  table: Readonly<Record<string, CellRoute>> = {
    acme: ACME,
    "acme.example": ACME,
    "cell:af-south-1": ACME,
  },
): FakeReader {
  const reader: FakeReader = {
    lookups: [],
    closed: 0,
    failing: false,
    ping: () => Promise.resolve(),
    resolve(lookup) {
      reader.lookups.push(lookup);
      if (reader.failing) {
        return Promise.reject(new DatabaseUnavailableError());
      }
      const key =
        "orgSlug" in lookup
          ? lookup.orgSlug
          : "cellId" in lookup
            ? `cell:${lookup.cellId}`
            : lookup.emailDomain;
      return Promise.resolve(table[key]);
    },
    close() {
      reader.closed += 1;
      return Promise.resolve();
    },
  };
  return reader;
}

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(
  reader: DirectoryReader | undefined,
  config: Record<string, string> = {
    DIRECTORY_DATABASE_URL: exampleValue("DIRECTORY_DATABASE_URL"),
  },
): Promise<NestFastifyApplication> {
  app = await createApp(loadApiConfig(apiEnv(config)), {
    probes: fakeProbes(),
    revocationStore: fixedRevocations(),
    ...(reader === undefined ? {} : { directoryReader: reader }),
  });
  await app.init();
  return app;
}

const get = async (url: string, headers: Record<string, string> = {}) => {
  if (app === undefined) throw new Error("no app");
  const res = await app.inject({ method: "GET", url, headers });
  return {
    status: res.statusCode,
    headers: res.headers,
    body: res.json<Record<string, unknown>>(),
  };
};

describe("the directory module stands alone (C4)", () => {
  test("its DI graph builds from the directory environment alone", async () => {
    const config = loadDirectoryConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DIRECTORY_DATABASE_URL: exampleValue("DIRECTORY_DATABASE_URL"),
    });
    const reader = openDirectoryReader(config.directory.url);
    const moduleRef = await NestFactory.createApplicationContext(
      DirectoryModule.forRoot({ reader }),
      { logger: false },
    );
    try {
      expect(moduleRef.get(DirectoryController)).toBeInstanceOf(
        DirectoryController,
      );
    } finally {
      await moduleRef.close();
    }
  });

  test("the module closes its reader on shutdown", async () => {
    const reader = fakeReader();
    const moduleRef = await NestFactory.createApplicationContext(
      DirectoryModule.forRoot({ reader }),
      { logger: false },
    );
    await moduleRef.close();
    expect(reader.closed).toBe(1);
  });

  test("its files import nothing from the cell database, withTx, the request context or provisioning", async () => {
    const files = (await readdir(MODULE_DIR)).filter((f) => f.endsWith(".ts"));
    expect(files.sort()).toEqual([
      "directory.controller.ts",
      "directory.dto.ts",
      "directory.module.ts",
      "directory.tokens.ts",
      "public-api.ts",
    ]);
    const allowed = new Set([
      "@nestjs/common",
      "nestjs-zod",
      "zod",
      "@bricx/db/directory",
      "../../common/auth/public.decorator.js",
      "../../common/errors/api-error.js",
      // P6-05d (ADR 0080, C2): the route's rate-limit class (no database).
      "../../common/rate-limit/rate-limit.decorator.js",
      "./directory.controller.js",
      "./directory.dto.js",
      "./directory.module.js",
      "./directory.tokens.js",
    ]);
    const found = new Set<string>();
    for (const file of files) {
      const text = await readFile(path.join(MODULE_DIR, file), "utf8");
      for (const m of text.matchAll(
        /(?:import|export)[^;]*?from\s+"([^"]+)"|import\(\s*"([^"]+)"\s*\)/g,
      )) {
        found.add(m[1] ?? m[2] ?? "");
      }
      for (const forbidden of [
        "withTx",
        "TxRunner",
        "RequestContext",
        "@bricx/db/database",
        "@bricx/config/api",
        "provision",
      ]) {
        expect([file, text.includes(forbidden)]).toEqual([file, false]);
      }
    }
    expect([...found].filter((s) => !allowed.has(s))).toEqual([]);
    expect(found.has("@bricx/db/directory")).toBe(true);
  });
});

describe("GET /v1/directory/resolve (C5)", () => {
  test("by slug: 200 with the cell route only, publicly cacheable for a day, no token needed", async () => {
    const reader = fakeReader();
    await start(reader);
    const res = await get(`${RESOLVE}?org_slug=acme`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...ACME });
    expect(Object.keys(res.body).sort()).toEqual([
      "apiBaseUrl",
      "cell",
      "keycloakUrl",
    ]);
    expect(res.headers["cache-control"]).toBe("public, max-age=86400");
    expect(reader.lookups).toEqual([{ orgSlug: "acme" }]);
  });

  test("by e-mail domain: the same answer; keys are normalised before the reader is asked", async () => {
    const reader = fakeReader();
    await start(reader);
    for (const query of [
      "email_domain=acme.example",
      "email_domain=ACME.Example",
      "email_domain=acme.example.",
    ]) {
      const res = await get(`${RESOLVE}?${query}`);
      expect([query, res.status, res.body]).toEqual([query, 200, { ...ACME }]);
    }
    expect((await get(`${RESOLVE}?org_slug=ACME`)).status).toBe(200);
    expect(reader.lookups).toEqual([
      { emailDomain: "acme.example" },
      { emailDomain: "acme.example" },
      { emailDomain: "acme.example" },
      { orgSlug: "acme" },
    ]);
  });

  // P6-06 (ADR 0077, D3): an invitation token's prefix.
  test("by cell id: the same route shape; unknown is the same 404; one key only", async () => {
    const reader = fakeReader();
    await start(reader);
    const found = await get(`${RESOLVE}?cell=AF-South-1`);
    expect(found.status).toBe(200);
    expect(found.body).toEqual({ ...ACME });
    expect(found.headers["cache-control"]).toBe("public, max-age=86400");
    const unknown = await get(`${RESOLVE}?cell=us-east-2`);
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("directory.not_found");
    expect(unknown.headers["cache-control"]).toBe("public, max-age=60");
    expect(reader.lookups).toEqual([
      { cellId: "af-south-1" },
      { cellId: "us-east-2" },
    ]);
    for (const query of [
      "cell=af-south-1&org_slug=acme",
      "cell=af-south-1&email_domain=acme.example",
      "cell=afsouth1",
      "cell=af-south-1.secret",
      `cell=af-${"x".repeat(40)}-1`,
    ]) {
      expect((await get(`${RESOLVE}?${query}`)).status, query).toBe(422);
    }
    expect(reader.lookups).toHaveLength(2);
  });

  test("unknown: 404 directory.not_found, max-age 60, the same body for a slug and a domain", async () => {
    await start(fakeReader());
    const bySlug = await get(`${RESOLVE}?org_slug=nobody`, {
      "x-request-id": "0199e1a0-0000-7000-8000-00000000aaaa",
    });
    const byDomain = await get(`${RESOLVE}?email_domain=nobody.example`, {
      "x-request-id": "0199e1a0-0000-7000-8000-00000000aaaa",
    });
    for (const res of [bySlug, byDomain]) {
      expect(res.status).toBe(404);
      expect(res.headers["content-type"]).toMatch(
        /^application\/problem\+json/,
      );
      expect(res.headers["cache-control"]).toBe("public, max-age=60");
      expect(res.body.code).toBe("directory.not_found");
      expect(res.body.key).toBe("errors:directory.not_found");
    }
    expect(bySlug.body).toEqual(byDomain.body);
  });

  test("neither key, both keys, an unknown key, a malformed or an oversized value: 422, and the reader is never asked", async () => {
    const reader = fakeReader();
    await start(reader);
    for (const query of [
      "",
      "org_slug=acme&email_domain=acme.example",
      "org_id=0199e1a0-0000-7000-8000-000000000001",
      "org_slug=acme&org_id=0199e1a0-0000-7000-8000-000000000001",
      "org_slug=a",
      "org_slug=-acme",
      "org_slug=ac%20me",
      `org_slug=${"a".repeat(64)}`,
      `org_slug=${"a".repeat(10_000)}`,
      "email_domain=localhost",
      "email_domain=a..example",
      `email_domain=${"a".repeat(250)}.com`,
      `email_domain=${"a".repeat(10_000)}`,
      "org_slug=acme&org_slug=beta",
    ]) {
      const res = await get(`${RESOLVE}?${query}`);
      expect([query.slice(0, 80), res.status, res.body.code]).toEqual([
        query.slice(0, 80),
        422,
        "validation_failed",
      ]);
      expect(res.headers["cache-control"] ?? "").not.toMatch(/public/);
    }
    expect(reader.lookups).toEqual([]);
  });

  test("a directory database that does not answer is 503 server_unavailable, never publicly cached", async () => {
    const reader = fakeReader();
    reader.failing = true;
    await start(reader);
    const res = await get(`${RESOLVE}?org_slug=acme`);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("server_unavailable");
    expect(res.headers["cache-control"] ?? "").not.toMatch(/public/);
  });

  test("without DIRECTORY_DATABASE_URL (a cell deployment) the route does not exist", async () => {
    await start(undefined, {});
    const res = await get(`${RESOLVE}?org_slug=acme`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("not_found");
  });

  test("createApp closes the reader when the app closes", async () => {
    const reader = fakeReader();
    await start(reader);
    await app?.close();
    app = undefined;
    expect(reader.closed).toBe(1);
  });
});
