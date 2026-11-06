// P6-01 (ADR 0071; owner conditions C1, C3 and C5): GET
// /v1/directory/resolve against compose.yml's Postgres with the real init
// folder and the real directory journal, through the directory_reader
// handle createApp opens from DIRECTORY_DATABASE_URL.
// - by slug and by verified domain: 200 with the cell route;
// - an unknown slug and an unknown domain: the same 404 body;
// - the reader never sees an organisation id; the API's handle is
//   directory_reader (its connections run as that role).
import { loadApiConfig } from "@bricx/config/api";
import {
  type BootstrappedPostgres,
  directoryDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { migrateDirectory } from "@bricx/db/migrate";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../../src/app.js";
import { apiEnv } from "../env.js";
import { fakeProbes } from "../probes.js";
import { fixedRevocations } from "../support/auth.js";

const ORG_A = "0192d4a0-0000-7000-8000-0000000000a1";
const ORG_B = "0192d4a0-0000-7000-8000-0000000000b1";
const TRACE = "0199e1a0-0000-7000-8000-00000000aaaa";

let pg: BootstrappedPostgres;
let app: NestFastifyApplication;

const url = (role: string, passwordKey: string) => ({
  reveal: () =>
    `postgres://${role}:${exampleValue(passwordKey)}@${pg.container.getHost()}:${String(pg.container.getMappedPort(5432))}/${directoryDatabase}`,
});

beforeAll(async () => {
  pg = await startPostgres();
  await migrateDirectory(url("directory_owner", "DIRECTORY_OWNER_PASSWORD"));
  const owner = await pg.connectAs("directory_owner", directoryDatabase);
  try {
    await owner.query(`INSERT INTO directory.cells (id, api_base_url, keycloak_url) VALUES
      ('af-south-1', 'https://api.af-south-1.bricx.invalid', 'https://id.af-south-1.bricx.invalid/realms/bricx'),
      ('eu-west-1', 'https://api.eu-west-1.bricx.invalid', 'https://id.eu-west-1.bricx.invalid/realms/bricx')`);
    await owner.query(
      `INSERT INTO directory.org_directory (org_id, org_slug, cell_id) VALUES
        ($1, 'acme', 'af-south-1'), ($2, 'beta', 'eu-west-1')`,
      [ORG_A, ORG_B],
    );
    // Seeded as directory_owner: P6-01 has no domain writer (C3).
    await owner.query(
      "INSERT INTO directory.org_email_domains (domain, org_id, verified_at) VALUES ('beta.example', $1, now())",
      [ORG_B],
    );
  } finally {
    await owner.end();
  }
  app = await createApp(
    loadApiConfig(
      apiEnv({
        DIRECTORY_DATABASE_URL: url(
          "directory_reader",
          "DIRECTORY_READER_PASSWORD",
        ).reveal(),
      }),
    ),
    { probes: fakeProbes(), revocationStore: fixedRevocations() },
  );
  await app.init();
});
afterAll(async () => {
  await app.close().catch(() => undefined);
  await pg.container.stop();
});

const resolve = async (query: string) => {
  const res = await app.inject({
    method: "GET",
    url: `/v1/directory/resolve?${query}`,
    headers: { "x-request-id": TRACE },
  });
  return {
    status: res.statusCode,
    cache: res.headers["cache-control"],
    body: res.json<Record<string, unknown>>(),
  };
};

describe("GET /v1/directory/resolve against the directory database", () => {
  test("by slug and by verified domain: 200 with the cell route", async () => {
    expect(await resolve("org_slug=acme")).toEqual({
      status: 200,
      cache: "public, max-age=86400",
      body: {
        cell: "af-south-1",
        apiBaseUrl: "https://api.af-south-1.bricx.invalid",
        keycloakUrl: "https://id.af-south-1.bricx.invalid/realms/bricx",
      },
    });
    const beta = {
      status: 200,
      cache: "public, max-age=86400",
      body: {
        cell: "eu-west-1",
        apiBaseUrl: "https://api.eu-west-1.bricx.invalid",
        keycloakUrl: "https://id.eu-west-1.bricx.invalid/realms/bricx",
      },
    };
    expect(await resolve("org_slug=beta")).toEqual(beta);
    expect(await resolve("email_domain=Beta.Example.")).toEqual(beta);
  });

  test("an unknown slug and an unknown domain: the same 404 body", async () => {
    const bySlug = await resolve("org_slug=nobody");
    const byDomain = await resolve("email_domain=acme.example");
    expect(bySlug).toEqual(byDomain);
    expect(bySlug.status).toBe(404);
    expect(bySlug.cache).toBe("public, max-age=60");
    expect(bySlug.body.code).toBe("directory.not_found");
  });

  test("the API's directory connections run as directory_reader, never another role", async () => {
    await resolve("org_slug=acme");
    const admin = await pg.admin();
    try {
      const r = await admin.query<{ usename: string }>(
        "SELECT DISTINCT usename FROM pg_stat_activity WHERE datname = $1 AND usename IS NOT NULL AND pid <> pg_backend_pid()",
        [directoryDatabase],
      );
      expect(r.rows.map((row) => row.usename)).toEqual(["directory_reader"]);
    } finally {
      await admin.end();
    }
  });
});
