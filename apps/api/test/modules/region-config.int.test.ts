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
// P6-05 (ADR 0075; owner conditions C1 and C2, dated note on ADR 0073):
// project rows belong to real projects (POST /v1/projects); an unknown or
// foreign project is 404 on GET /effective?projectId=, GET and PATCH
// /projects/{id}; an archived project's PATCH is 409; a project row never
// holds currency, reporting currency or timezone (422): the project's own
// columns are that layer. The P6-04 adapter checks run on real project
// rows (ADR 0075 D13).
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
import { defaultAdapters } from "@bricx/adapters/registry";
import type { AdapterDescriptor } from "@bricx/adapters/types";
import { SESSION_IDLE_SECONDS } from "@bricx/domain/limits";
import { REGION_CONFIG_FIELDS } from "@bricx/domain/region-config";
import { ErrorEnvelopeSchema } from "@bricx/validation/error-envelope";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../../src/app.js";
import { Organization } from "../../src/modules/organizations/organizations.dto.js";
import { Project } from "../../src/modules/projects/projects.dto.js";
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
import { memoryRateLimits } from "../support/rate-limit.js";

const HOOK_MS = 300_000;
const CELL = "af-south-1";
/** A project id no organisation has (P6-05 C2: 404). */
const UNKNOWN_PROJECT = "0199e1d2-0000-7000-8000-00000000000b";
// P6-04 (ADR 0074, D15): the dev registry plus the test adapters these
// suites write (createApp's test-only `adapters` option). Every other id
// is unknown to the registry.
const testAdapter = (
  id: string,
  kind: "payment" | "accounting",
): AdapterDescriptor => ({
  id,
  kind,
  countries: ["SL", "NG"],
  currencies: ["SLE", "NGN", "USD"],
});
const TEST_ADAPTERS: readonly AdapterDescriptor[] = [
  ...defaultAdapters("test"),
  testAdapter("orange_money", "payment"),
  testAdapter("mpesa", "payment"),
  testAdapter("stripe", "payment"),
  testAdapter("xero", "accounting"),
];

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
    {
      probes: fakeProbes(),
      revocationStore: fixedRevocations(),
      rateLimitStore: memoryRateLimits(),
      clock,
      adapters: TEST_ADAPTERS,
    },
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
  const owner = { sub, org: org.id };
  return { org, owner, project: await newProject(owner) };
}

/** A new draft project of the caller's org (P6-05), its id. */
async function newProject(
  owner: Caller,
  body: Record<string, unknown> = {},
): Promise<string> {
  const res = await call(
    owner,
    "POST",
    "/v1/projects",
    { code: `RC-${String(next())}`, name: "Region project", ...body },
    `rc-project-${String(next()).padStart(8, "0")}`,
  );
  expect(res.statusCode, res.body).toBe(201);
  return Project.schema.parse(JSON.parse(res.body)).id;
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
    // P6-05 (C1): currency, reporting currency and timezone are the
    // project's own columns, set when it is created.
    const PROJECT = await newProject(owner, {
      currency: "USD",
      reportingCurrency: "EUR",
      timezone: "Africa/Lagos",
    });
    const patched = await call(
      owner,
      "PATCH",
      `/v1/region-config/projects/${PROJECT}`,
      {
        language: "fr",
        units: "us_customary",
        taxProfileId: "ng_vat",
      },
    );
    expect(patched.statusCode, patched.body).toBe(200);
    expect(
      RegionConfigLayer.schema.parse(JSON.parse(patched.body)),
    ).toMatchObject({
      projectId: PROJECT,
      currency: null,
      language: "fr",
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
    // Another project of the org has no row: the org layer, and its own
    // columns (set from the effective org values when it was created).
    const OTHER_PROJECT = await newProject(owner);
    expect(await effective(owner, OTHER_PROJECT)).toMatchObject({
      currency: { value: "SLE", source: "project" },
      reportingCurrency: { value: "USD", source: "project" },
      language: { value: "en", source: "org" },
      units: { value: "metric", source: "org" },
      taxProfileId: { value: null, source: "system" },
    });
    // null inherits again.
    await call(owner, "PATCH", `/v1/region-config/projects/${PROJECT}`, {
      language: null,
    });
    expect((await effective(owner, PROJECT)).language).toEqual({
      value: "en",
      source: "org",
    });
  });

  test("the stored rows read back: GET /v1/region-config and /projects/:id; a layer with no row is all null", async () => {
    const { owner, project: PROJECT } = await newOrg();
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
    ["an unknown unit system", { units: "imperial" }],
    // P6-05 (C1): the project's own columns are that layer.
    ["a currency on a project row (C1)", { currency: "USD" }],
    [
      "a reporting currency on a project row (C1)",
      { reportingCurrency: "EUR" },
    ],
    ["a timezone on a project row (C1)", { timezone: "Africa/Lagos" }],
  ])("project row, %s: 422, nothing written", async (_what, body) => {
    const { org, owner, project: PROJECT } = await newOrg();
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
    const { org, owner, project: PROJECT } = await newOrg();
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
    const { org, owner, project: PROJECT } = await newOrg();
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

describe("the adapter registry (P6-04 Done when 4; the P6-03 Also line, ADR 0074 D9 and D10)", () => {
  const unknownAt = (path: readonly (string | number)[]) => ({
    path,
    code: "unknown_adapter",
    key: "validation:unknown_adapter",
  });

  test.each([
    ["the org row", "/v1/region-config"],
    // P6-05 (ADR 0075 D13): a real project's row.
    ["a project row", "/v1/region-config/projects/"],
  ])(
    "%s: an unknown or wrong-kind id is 422 unknown_adapter, never the value; nothing written or audited",
    async (_layer, path) => {
      const { org, owner, project } = await newOrg();
      const url = path.endsWith("/") ? `${path}${project}` : path;
      const cases: [unknown, unknown[]][] = [
        [
          { paymentAdapters: ["mpesa", "zz_unknown_pay"] },
          [unknownAt(["paymentAdapters"])],
        ],
        [
          { accountingAdapter: "zz_unknown_books" },
          [unknownAt(["accountingAdapter"])],
        ],
        // Wrong kind: an accounting id as a payment adapter and back.
        [
          { paymentAdapters: ["xero"], accountingAdapter: "stripe" },
          [unknownAt(["paymentAdapters"]), unknownAt(["accountingAdapter"])],
        ],
        // A Null adapter of another kind.
        [
          { accountingAdapter: "null_payment" },
          [unknownAt(["accountingAdapter"])],
        ],
      ];
      for (const [body, issues] of cases) {
        const res = await call(owner, "PATCH", url, body);
        expectProblem(res, 422, "validation_failed");
        expect(JSON.parse(res.body)).toMatchObject({ issues });
        for (const value of ["zz_unknown", "xero", "stripe", "null_payment"]) {
          expect(res.body).not.toContain(value);
        }
      }
      expect(await rowsOf(org.id)).toEqual([]);
      expect(await auditOf(org.id)).toEqual([]);
    },
  );

  test("registered ids are written: the Null adapters and the test adapters", async () => {
    const { org, owner } = await newOrg();
    const res = await call(owner, "PATCH", "/v1/region-config", {
      paymentAdapters: ["null_payment", "mpesa"],
      accountingAdapter: "null_accounting",
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await auditOf(org.id)).toHaveLength(1);
  });

  test("stored ids the registry does not know are returned as they are by both GET routes and /effective (D10)", async () => {
    const { org, owner, project: PROJECT } = await newOrg();
    for (const url of [
      "/v1/region-config",
      `/v1/region-config/projects/${PROJECT}`,
    ]) {
      expect(
        (await call(owner, "PATCH", url, { rateLibrary: "seed" })).statusCode,
      ).toBe(200);
    }
    // Ids written behind the registry's back (an adapter since removed).
    await asAdmin(
      `UPDATE bricx.region_configs
         SET payment_adapters = '{gone_pay,mpesa}', accounting_adapter = 'gone_books'
       WHERE org_id = $1 AND project_id IS NULL`,
      [org.id],
    );
    await asAdmin(
      `UPDATE bricx.region_configs SET accounting_adapter = 'gone_ledger'
       WHERE org_id = $1 AND project_id = $2`,
      [org.id, PROJECT],
    );
    const orgRow = await call(owner, "GET", "/v1/region-config");
    expect(orgRow.statusCode, orgRow.body).toBe(200);
    expect(JSON.parse(orgRow.body)).toMatchObject({
      paymentAdapters: ["gone_pay", "mpesa"],
      accountingAdapter: "gone_books",
    });
    const projectRow = await call(
      owner,
      "GET",
      `/v1/region-config/projects/${PROJECT}`,
    );
    expect(JSON.parse(projectRow.body)).toMatchObject({
      accountingAdapter: "gone_ledger",
    });
    expect(await effective(owner, PROJECT)).toMatchObject({
      paymentAdapters: { value: ["gone_pay", "mpesa"], source: "org" },
      accountingAdapter: { value: "gone_ledger", source: "project" },
    });
    // A no-change body repeating the stale ids is 200 and writes nothing (C1).
    const before = await rowsOf(org.id);
    const events = (await auditOf(org.id)).length;
    const same = await call(owner, "PATCH", "/v1/region-config", {
      paymentAdapters: ["mpesa", "gone_pay"],
      accountingAdapter: "gone_books",
    });
    expect(same.statusCode, same.body).toBe(200);
    expect(await rowsOf(org.id)).toEqual(before);
    expect(await auditOf(org.id)).toHaveLength(events);
    // Changing the list keeps it checked in full: the stale id must go.
    const kept = await call(owner, "PATCH", "/v1/region-config", {
      paymentAdapters: ["gone_pay", "mpesa", "stripe"],
    });
    expectProblem(kept, 422, "validation_failed");
    expect(JSON.parse(kept.body)).toMatchObject({
      issues: [unknownAt(["paymentAdapters"])],
    });
    const dropped = await call(owner, "PATCH", "/v1/region-config", {
      paymentAdapters: ["mpesa", "stripe"],
    });
    expect(dropped.statusCode, dropped.body).toBe(200);
  });
});

describe("permissions and isolation (Done-when 3, owner condition C4)", () => {
  test("another organisation's project is 404 on every project route, like an unknown one; its values never leak (P6-05 C2)", async () => {
    const a = await newOrg();
    const b = await newOrg("KE", "KES");
    const PROJECT = b.project;
    expect(
      (
        await call(b.owner, "PATCH", `/v1/region-config/projects/${PROJECT}`, {
          language: "fr",
        })
      ).statusCode,
    ).toBe(200);
    for (const id of [PROJECT, UNKNOWN_PROJECT]) {
      for (const res of [
        await call(a.owner, "GET", `/v1/region-config/projects/${id}`),
        await call(
          a.owner,
          "GET",
          `/v1/region-config/effective?projectId=${id}`,
        ),
        await call(a.owner, "PATCH", `/v1/region-config/projects/${id}`, {
          language: "en",
        }),
      ]) {
        expectProblem(res, 404, "not_found");
        expect(res.body).not.toContain("fr");
      }
    }
    expect(await rowsOf(a.org.id)).toEqual([]);
    expect(
      RegionConfigLayer.schema.parse(
        JSON.parse(
          (await call(b.owner, "GET", `/v1/region-config/projects/${PROJECT}`))
            .body,
        ),
      ).language,
    ).toBe("fr");
  });

  test("an archived project's row reads (200) but its PATCH is 409, nothing written (P6-05 C2)", async () => {
    const { org, owner, project } = await newOrg();
    const moved = await call(
      owner,
      "POST",
      `/v1/projects/${project}/status`,
      { to: "archived" },
      `rc-archive-${String(next()).padStart(8, "0")}`,
    );
    expect(moved.statusCode, moved.body).toBe(200);
    expect(
      (await call(owner, "GET", `/v1/region-config/projects/${project}`))
        .statusCode,
    ).toBe(200);
    expect((await effective(owner, project)).projectId).toBe(project);
    expectProblem(
      await call(owner, "PATCH", `/v1/region-config/projects/${project}`, {
        language: "fr",
      }),
      409,
      "request.conflict",
    );
    expect(await rowsOf(org.id)).toEqual([]);
  });

  test("every role reads; only the owner (org.region_config.update) writes, project routes included", async () => {
    const { org, owner, project: PROJECT } = await newOrg();
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
          language: "fr",
        },
      ),
      403,
      "forbidden",
    );
    expect(await rowsOf(org.id)).toEqual([]);
    expect(
      (
        await call(owner, "PATCH", `/v1/region-config/projects/${PROJECT}`, {
          language: "fr",
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
