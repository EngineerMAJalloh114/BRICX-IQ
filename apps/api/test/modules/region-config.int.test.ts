// Region configuration end to end (P6-03, ADR 0073), against Postgres with
// the production journal, as bricx_app through the real app, the real
// AuthGuard (tokens from the local issuer), the production DbGrantsSource
// and the production DbOrgSessionPolicy. Organisations are created through
// POST /v1/organizations, so their owner and roles are the real bootstrap.
// Proves the task plan's Done-whens and the owner's conditions:
// - Done-when 1/2: GET /v1/region-config/effective gives every field's
//   value and provenance; project > org > system; null inherits;
// - Done-when 2/C3: each field's validation answers 422 with no value in
//   the body; the org row refuses currency, language, timezone and units,
//   a project row the idle timeout (unknown field, nothing written);
// - C1/Done-when 7: an empty PATCH is 422 and writes nothing; a body with
//   no change is 200 and writes no audit event; a change writes exactly
//   one audit event naming the fields, never the values;
// - Done-when 3/C4: another organisation's rows are invisible; every route
//   needs the org-scope key (org.region_config.read / update): a project
//   role holding project.project.update on the project is refused;
// - Done-when 4: the org's idle timeout shortens the session: 401
//   session_expired after the org's limit, while an org without one keeps
//   the realm's 12 h.
import { loadApiConfig } from "@bricx/config/api";
import {
  type BootstrappedPostgres,
  appDatabase,
  directoryDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { ensureDevCells } from "@bricx/db/dev-cells";
import { migrate, migrateDirectory } from "@bricx/db/migrate";
import { SESSION_IDLE_SECONDS } from "@bricx/domain/limits";
import { REGION_CONFIG_FIELDS } from "@bricx/domain/region-config";
import { ErrorEnvelopeSchema } from "@bricx/validation/error-envelope";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../../src/app.js";
import { Organization } from "../../src/modules/organizations/organizations.dto.js";
import {
  EffectiveRegionConfig,
  RegionConfigLayer,
} from "../../src/modules/region-config/region-config.dto.js";
import { apiEnv } from "../env.js";
import { fakeProbes } from "../probes.js";
import {
  TestIssuer,
  applyAccess,
  bearer,
  fixedRevocations,
} from "../support/auth.js";

const HOOK_MS = 300_000;
const CELL = "af-south-1";
const PROJECT = "0199e1d2-0000-7000-8000-00000000000b";
const OTHER_PROJECT = "0199e1d2-0000-7000-8000-00000000000c";

let pg18: BootstrappedPostgres;
let issuer: TestIssuer;
let app: NestFastifyApplication;
// A clock the test moves (the session idle check, Done-when 4); tokens are
// minted on it too.
const BASE_MS = Date.now();
const clock = { offsetMs: 0, now: () => BASE_MS + clock.offsetMs };

const host = () =>
  `${pg18.container.getHost()}:${String(pg18.container.getMappedPort(5432))}`;
const appUrl = (role: string, key: string) =>
  `postgres://${role}:${exampleValue(key)}@${host()}/${appDatabase}`;
const directoryUrl = (role: string, key: string) =>
  `postgres://${role}:${exampleValue(key)}@${host()}/${directoryDatabase}`;

async function asAdmin<R extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  const admin = await pg18.admin();
  try {
    return (await admin.query<R>(text, params)).rows;
  } finally {
    await admin.end();
  }
}

beforeAll(async () => {
  [pg18, issuer] = await Promise.all([startPostgres(), TestIssuer.start()]);
  issuer.nowSeconds = () => Math.floor(clock.now() / 1000);
  await migrate({
    reveal: () => appUrl("bricx_owner", "BRICX_OWNER_PASSWORD"),
  });
  const owner = {
    reveal: () => directoryUrl("directory_owner", "DIRECTORY_OWNER_PASSWORD"),
  };
  await migrateDirectory(owner);
  await ensureDevCells(owner);
  app = await createApp(
    loadApiConfig(
      apiEnv({
        ...issuer.env(),
        DATABASE_URL: appUrl("bricx_app", "BRICX_APP_PASSWORD"),
        CELL_ID: CELL,
        DIRECTORY_WRITER_DATABASE_URL: directoryUrl(
          "directory_writer",
          "DIRECTORY_WRITER_PASSWORD",
        ),
      }),
    ),
    { probes: fakeProbes(), revocationStore: fixedRevocations(), clock },
  );
  await app.init();
}, HOOK_MS);
afterAll(async () => {
  await app.close().catch(() => undefined);
  await issuer.close();
  await pg18.container.stop();
}, HOOK_MS);

let counter = 0;
const next = () => {
  counter += 1;
  return counter;
};
const newSub = () => `rc-user-${String(next())}`;

type Res = Awaited<ReturnType<NestFastifyApplication["inject"]>>;

interface Caller {
  readonly sub: string;
  readonly org?: string;
  readonly sid?: string;
}

async function call(
  who: Caller,
  method: "GET" | "POST" | "PATCH",
  url: string,
  body?: unknown,
  key?: string,
): Promise<Res> {
  const token = await issuer.token({
    sub: who.sub,
    org_id: who.org,
    ...(who.sid === undefined ? {} : { sid: who.sid }),
  });
  return app.inject({
    method,
    url,
    headers: {
      ...bearer(token),
      ...(key === undefined ? {} : { "idempotency-key": key }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

function expectProblem(res: Res, status: number, code: string) {
  expect(res.statusCode, res.body).toBe(status);
  const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(res.body));
  expect(parsed.success).toBe(true);
  expect(parsed.data).toMatchObject({ status, code, key: `errors:${code}` });
}

/** A new organisation through the API; its creator is the owner. */
async function newOrg(country = "SL", currency = "SLE") {
  const sub = newSub();
  const res = await call(
    { sub },
    "POST",
    "/v1/organizations",
    {
      slug: `rc-${String(next())}`,
      legalName: "Region Config Ltd",
      country,
      defaultCurrency: currency,
      defaultLanguage: "en",
      timezone: "Africa/Freetown",
    },
    `rc-key-${String(next()).padStart(8, "0")}`,
  );
  expect(res.statusCode, res.body).toBe(201);
  const org = Organization.schema.parse(JSON.parse(res.body));
  return { org, owner: { sub, org: org.id } };
}

/** A member of `org` with `role` (and project memberships). */
async function member(
  org: string,
  role: string,
  projects: readonly string[] = [],
): Promise<Caller> {
  const sub = newSub();
  // The users row first (any request provisions it).
  await call({ sub, org }, "GET", "/v1/region-config");
  const [row] = await asAdmin<{ id: string }>(
    "SELECT id::text FROM bricx.users WHERE keycloak_sub = $1",
    [sub],
  );
  if (row === undefined) throw new Error("no users row");
  await applyAccess(asAdmin, { orgId: org, userId: row.id, role, projects });
  return { sub, org };
}

const auditOf = (org: string) =>
  asAdmin<{
    action: string;
    entity_type: string;
    before: unknown;
    after: unknown;
  }>(
    `SELECT action, entity_type, before, after FROM bricx.audit_events
     WHERE org_id = $1 AND entity_type = 'org.region_config' ORDER BY seq`,
    [org],
  );

const rowsOf = (org: string) =>
  asAdmin<{ project_id: string | null; updated_at: string }>(
    `SELECT project_id::text, updated_at::text FROM bricx.region_configs
     WHERE org_id = $1 ORDER BY project_id NULLS FIRST`,
    [org],
  );

const effective = async (who: Caller, projectId?: string) => {
  const res = await call(
    who,
    "GET",
    `/v1/region-config/effective${projectId === undefined ? "" : `?projectId=${projectId}`}`,
  );
  expect(res.statusCode, res.body).toBe(200);
  return EffectiveRegionConfig.schema.parse(JSON.parse(res.body));
};

describe("the effective configuration (Done-when 1 and 2)", () => {
  test("an organisation with no rows: its own columns (org) and the derived defaults (system)", async () => {
    const { owner } = await newOrg();
    const resolved = await effective(owner);
    expect(resolved).toEqual({
      projectId: null,
      currency: { value: "SLE", source: "org" },
      reportingCurrency: { value: "SLE", source: "system" },
      language: { value: "en", source: "org" },
      timezone: { value: "Africa/Freetown", source: "org" },
      formatLocale: { value: "en-SL", source: "system" },
      units: { value: "metric", source: "org" },
      taxProfileId: { value: null, source: "system" },
      paymentAdapters: { value: [], source: "system" },
      accountingAdapter: { value: null, source: "system" },
      rateLibrary: { value: null, source: "system" },
      sessionIdleSeconds: {
        value: SESSION_IDLE_SECONDS.max,
        source: "system",
      },
    });
    expect(
      Object.keys(resolved)
        .filter((k) => k !== "projectId")
        .sort(),
    ).toEqual([...REGION_CONFIG_FIELDS].sort());
  });

  test("project wins over org, which wins over system; null goes back to inherit", async () => {
    const { owner } = await newOrg();
    expect(
      (
        await call(owner, "PATCH", "/v1/region-config", {
          reportingCurrency: "USD",
          formatLocale: "en-gb",
          paymentAdapters: ["orange_money", "mpesa"],
          accountingAdapter: "xero",
          sessionIdleSeconds: 3_600,
        })
      ).statusCode,
    ).toBe(200);
    const patched = await call(
      owner,
      "PATCH",
      `/v1/region-config/projects/${PROJECT}`,
      {
        currency: "USD",
        language: "fr",
        timezone: "Africa/Lagos",
        units: "us_customary",
        reportingCurrency: "EUR",
        taxProfileId: "ng_vat",
      },
    );
    expect(patched.statusCode, patched.body).toBe(200);
    expect(
      RegionConfigLayer.schema.parse(JSON.parse(patched.body)),
    ).toMatchObject({
      projectId: PROJECT,
      currency: "USD",
      sessionIdleSeconds: null,
    });
    const forProject = await effective(owner, PROJECT);
    expect(forProject).toMatchObject({
      projectId: PROJECT,
      currency: { value: "USD", source: "project" },
      reportingCurrency: { value: "EUR", source: "project" },
      language: { value: "fr", source: "project" },
      timezone: { value: "Africa/Lagos", source: "project" },
      formatLocale: { value: "en-GB", source: "org" },
      units: { value: "us_customary", source: "project" },
      taxProfileId: { value: "ng_vat", source: "project" },
      paymentAdapters: { value: ["mpesa", "orange_money"], source: "org" },
      accountingAdapter: { value: "xero", source: "org" },
      rateLibrary: { value: null, source: "system" },
      sessionIdleSeconds: { value: 3_600, source: "org" },
    });
    // Another project of the org sees the org layer only.
    expect(await effective(owner, OTHER_PROJECT)).toMatchObject({
      currency: { value: "SLE", source: "org" },
      reportingCurrency: { value: "USD", source: "org" },
    });
    // null inherits again.
    await call(owner, "PATCH", `/v1/region-config/projects/${PROJECT}`, {
      reportingCurrency: null,
    });
    await call(owner, "PATCH", "/v1/region-config", {
      reportingCurrency: null,
    });
    expect((await effective(owner, PROJECT)).reportingCurrency).toEqual({
      value: "USD",
      source: "system",
    });
  });

  test("the stored rows read back: GET /v1/region-config and /projects/:id; a layer with no row is all null", async () => {
    const { owner } = await newOrg();
    const empty = await call(owner, "GET", "/v1/region-config");
    expect(empty.statusCode).toBe(200);
    const layer = RegionConfigLayer.schema.parse(JSON.parse(empty.body));
    expect(layer).toMatchObject({
      projectId: null,
      reportingCurrency: null,
      createdAt: null,
      updatedAt: null,
    });
    await call(owner, "PATCH", `/v1/region-config/projects/${PROJECT}`, {
      rateLibrary: "sl_2026",
    });
    const project = await call(
      owner,
      "GET",
      `/v1/region-config/projects/${PROJECT}`,
    );
    expect(
      RegionConfigLayer.schema.parse(JSON.parse(project.body)),
    ).toMatchObject({ projectId: PROJECT, rateLibrary: "sl_2026" });
  });
});

describe("validation (Done-when 2, owner condition C3)", () => {
  test.each([
    ["an unknown currency", { reportingCurrency: "ABC" }],
    ["a malformed format locale", { formatLocale: "en_GB" }],
    ["an adapter id with capitals", { accountingAdapter: "Xero" }],
    ["a duplicate payment adapter", { paymentAdapters: ["mpesa", "mpesa"] }],
    [
      "seventeen payment adapters",
      {
        paymentAdapters: Array.from(
          { length: 17 },
          (_, i) => `pay_${String(i)}`,
        ),
      },
    ],
    ["a bad tax profile reference", { taxProfileId: "-x" }],
    [
      "an idle timeout above 12 h",
      { sessionIdleSeconds: SESSION_IDLE_SECONDS.max + 1 },
    ],
    [
      "an idle timeout below one minute",
      { sessionIdleSeconds: SESSION_IDLE_SECONDS.min - 1 },
    ],
    ["a fractional idle timeout", { sessionIdleSeconds: 600.5 }],
    ["the org's currency on the org row (D8)", { currency: "USD" }],
    ["the org's language on the org row (D8)", { language: "fr" }],
    ["the org's timezone on the org row (D8)", { timezone: "Africa/Lagos" }],
    ["the org's units on the org row (D8)", { units: "us_customary" }],
    ["an unknown field", { colour: "blue" }],
  ])(
    "org row, %s: 422 validation_failed, no value echoed, nothing written",
    async (_what, body) => {
      const { org, owner } = await newOrg();
      const res = await call(owner, "PATCH", "/v1/region-config", body);
      expectProblem(res, 422, "validation_failed");
      for (const value of Object.values(body)) {
        if (typeof value === "string") expect(res.body).not.toContain(value);
      }
      expect(await rowsOf(org.id)).toEqual([]);
      expect(await auditOf(org.id)).toEqual([]);
    },
  );

  test.each([
    ["the idle timeout on a project row (D10)", { sessionIdleSeconds: 600 }],
    ["an unsupported language", { language: "de" }],
    ["an unknown time zone", { timezone: "Mars/Olympus" }],
    ["an unknown unit system", { units: "imperial" }],
  ])("project row, %s: 422, nothing written", async (_what, body) => {
    const { org, owner } = await newOrg();
    expectProblem(
      await call(owner, "PATCH", `/v1/region-config/projects/${PROJECT}`, body),
      422,
      "validation_failed",
    );
    expect(await rowsOf(org.id)).toEqual([]);
  });

  test("a malformed project id is 422 on every project route and the effective read", async () => {
    const { owner } = await newOrg();
    expectProblem(
      await call(owner, "GET", "/v1/region-config/projects/not-a-uuid"),
      422,
      "validation_failed",
    );
    expectProblem(
      await call(owner, "PATCH", "/v1/region-config/projects/not-a-uuid", {
        rateLibrary: "x",
      }),
      422,
      "validation_failed",
    );
    expectProblem(
      await call(owner, "GET", "/v1/region-config/effective?projectId=nope"),
      422,
      "validation_failed",
    );
  });
});

describe("writes and audit (owner condition C1, Done-when 7)", () => {
  test("an empty PATCH body is 422 on both layers, and nothing is written", async () => {
    const { org, owner } = await newOrg();
    expectProblem(
      await call(owner, "PATCH", "/v1/region-config", {}),
      422,
      "validation_failed",
    );
    expectProblem(
      await call(owner, "PATCH", `/v1/region-config/projects/${PROJECT}`, {}),
      422,
      "validation_failed",
    );
    expectProblem(
      await call(owner, "PATCH", "/v1/region-config"),
      422,
      "validation_failed",
    );
    expect(await rowsOf(org.id)).toEqual([]);
    expect(await auditOf(org.id)).toEqual([]);
  });

  test("a change writes one audit event naming the fields, never the values; the same body again is 200 with no event and no write", async () => {
    const { org, owner } = await newOrg();
    const body = {
      reportingCurrency: "USD",
      paymentAdapters: ["stripe", "mpesa"],
      sessionIdleSeconds: 900,
    };
    const first = await call(owner, "PATCH", "/v1/region-config", body);
    expect(first.statusCode, first.body).toBe(200);
    const events = await auditOf(org.id);
    expect(events).toEqual([
      {
        action: "org.region_config.update",
        entity_type: "org.region_config",
        before: null,
        after: {
          fields: [
            "reportingCurrency",
            "paymentAdapters",
            "sessionIdleSeconds",
          ],
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("USD");
    expect(JSON.stringify(events)).not.toContain("stripe");
    const [stored] = await rowsOf(org.id);
    // Same values (the list in another order): 200, no event, no write.
    const again = await call(owner, "PATCH", "/v1/region-config", {
      ...body,
      paymentAdapters: ["mpesa", "stripe"],
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(JSON.parse(again.body)).toEqual(JSON.parse(first.body));
    expect(await auditOf(org.id)).toHaveLength(1);
    expect(await rowsOf(org.id)).toEqual([stored]);
    // Setting null on a layer with no row changes nothing either.
    const nothing = await call(
      owner,
      "PATCH",
      `/v1/region-config/projects/${PROJECT}`,
      { rateLibrary: null },
    );
    expect(nothing.statusCode).toBe(200);
    expect(await rowsOf(org.id)).toHaveLength(1);
    // One real change among unchanged fields names only that field.
    await call(owner, "PATCH", "/v1/region-config", {
      ...body,
      sessionIdleSeconds: 600,
    });
    await call(owner, "PATCH", `/v1/region-config/projects/${PROJECT}`, {
      units: "us_customary",
    });
    expect((await auditOf(org.id)).slice(1)).toEqual([
      {
        action: "org.region_config.update",
        entity_type: "org.region_config",
        before: null,
        after: { fields: ["sessionIdleSeconds"] },
      },
      {
        action: "org.region_config.project_update",
        entity_type: "org.region_config",
        before: null,
        after: { fields: ["units"] },
      },
    ]);
  });
});

describe("permissions and isolation (Done-when 3, owner condition C4)", () => {
  test("another organisation's rows are invisible: its project row reads as empty, its values never leak", async () => {
    const a = await newOrg();
    const b = await newOrg("KE", "KES");
    await call(b.owner, "PATCH", `/v1/region-config/projects/${PROJECT}`, {
      currency: "USD",
    });
    const res = await call(
      a.owner,
      "GET",
      `/v1/region-config/projects/${PROJECT}`,
    );
    expect(
      RegionConfigLayer.schema.parse(JSON.parse(res.body)).currency,
    ).toBeNull();
    expect((await effective(a.owner, PROJECT)).currency).toEqual({
      value: "SLE",
      source: "org",
    });
  });

  test("every role reads; only the owner (org.region_config.update) writes, project routes included", async () => {
    const { org, owner } = await newOrg();
    const accountant = await member(org.id, "accountant");
    expect(
      (await call(accountant, "GET", "/v1/region-config")).statusCode,
    ).toBe(200);
    expect(
      (await call(accountant, "GET", "/v1/region-config/effective")).statusCode,
    ).toBe(200);
    expectProblem(
      await call(accountant, "PATCH", "/v1/region-config", {
        reportingCurrency: "USD",
      }),
      403,
      "forbidden",
    );
    // A project owner holds project.project.update on PROJECT, but not the
    // org-scope key: the project routes refuse them (C4).
    const projectOwner = await member(org.id, "project_owner", [PROJECT]);
    expectProblem(
      await call(
        projectOwner,
        "PATCH",
        `/v1/region-config/projects/${PROJECT}`,
        {
          currency: "USD",
        },
      ),
      403,
      "forbidden",
    );
    expect(await rowsOf(org.id)).toEqual([]);
    expect(
      (
        await call(owner, "PATCH", `/v1/region-config/projects/${PROJECT}`, {
          currency: "USD",
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe("the session idle timeout (Done-when 4, P5 phase ruling D6)", () => {
  test("the org's value shortens the session (401 session_expired after it); an org without one keeps the realm's 12 h", async () => {
    const short = await newOrg();
    const realm = await newOrg();
    const IDLE = 600;
    expect(
      (
        await call(short.owner, "PATCH", "/v1/region-config", {
          sessionIdleSeconds: IDLE,
        })
      ).statusCode,
    ).toBe(200);
    const shortSession: Caller = { ...short.owner, sid: "rc-idle-short" };
    const realmSession: Caller = { ...realm.owner, sid: "rc-idle-realm" };
    try {
      expect(
        (await call(shortSession, "GET", "/v1/region-config")).statusCode,
      ).toBe(200);
      expect(
        (await call(realmSession, "GET", "/v1/region-config")).statusCode,
      ).toBe(200);
      // Active within the limit: still in.
      clock.offsetMs += (IDLE - 60) * 1000;
      expect(
        (await call(shortSession, "GET", "/v1/region-config")).statusCode,
      ).toBe(200);
      // Idle past the org's limit: refused; the realm org is not.
      clock.offsetMs += (IDLE + 1) * 1000;
      expectProblem(
        await call(shortSession, "GET", "/v1/region-config"),
        401,
        "session_expired",
      );
      expect(
        (await call(realmSession, "GET", "/v1/region-config")).statusCode,
      ).toBe(200);
    } finally {
      clock.offsetMs = 0;
    }
  });

  test("a value above 12 h is refused (422) and the stored limit is unchanged", async () => {
    const { org, owner } = await newOrg();
    expectProblem(
      await call(owner, "PATCH", "/v1/region-config", {
        sessionIdleSeconds: SESSION_IDLE_SECONDS.max + 1,
      }),
      422,
      "validation_failed",
    );
    expect(await rowsOf(org.id)).toEqual([]);
  });
});
