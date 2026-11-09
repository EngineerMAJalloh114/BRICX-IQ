// Projects and sites end to end (P6-05, ADR 0075; owner conditions C1,
// C3, C5–C8), against Postgres with the production journal, as bricx_app
// through the real app, the real AuthGuard (tokens from the local
// issuer) and the production DbGrantsSource. Organisations are created
// through POST /v1/organizations, so their owner is the real bootstrap;
// other members are seeded rows (test/support applyAccess).
// - Done-when 1: CRUD with permissions (project.project.create at org
//   scope; read/update/archive at org or project scope; the site keys);
//   RLS isolates projects by org and project: a project member of A gets
//   the same 404 on B as on an unknown id (C5); nobody becomes a member
//   on creation (D7, C5);
// - Done-when 2: contractValue round-trips as MoneySchema minor units;
//   only callers holding project.project.update on the project read or
//   write it, others get null (C8); the audit never holds an amount;
// - Done-when 3: the status route follows the machine (C3): archive needs
//   project.project.archive, other moves project.project.update, a refused
//   move is 409; an archived project and its sites are read-only (409);
// - Done-when 4: a site's boundary is stored normalised (C6: CW and CCW
//   input store identically); a self-intersecting boundary is 422
//   invalid_polygon, one over 1 000 km² 422 polygon_too_large, never 500;
// - Done-when 6: the code is unique per org regardless of case (409, C7);
// - C1: currency, reporting currency and timezone change only in draft;
// - C5: lists are keyset-paged by id (UUIDv7), newest first.
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
import { ErrorEnvelopeSchema } from "@bricx/validation/error-envelope";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../../src/app.js";
import { Organization } from "../../src/modules/organizations/organizations.dto.js";
import {
  Project,
  ProjectPage,
} from "../../src/modules/projects/projects.dto.js";
import { Site, SitePage } from "../../src/modules/projects/sites.dto.js";
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

let pg18: BootstrappedPostgres;
let issuer: TestIssuer;
let app: NestFastifyApplication;

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
const newSub = () => `pj-user-${String(next())}`;
const key = () => `pj-key-${String(next()).padStart(8, "0")}`;

type Res = Awaited<ReturnType<NestFastifyApplication["inject"]>>;

interface Caller {
  readonly sub: string;
  readonly org?: string;
}

async function call(
  who: Caller,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
): Promise<Res> {
  const token = await issuer.token({ sub: who.sub, org_id: who.org });
  return app.inject({
    method,
    url,
    headers: {
      ...bearer(token),
      ...(method === "POST" ? { "idempotency-key": key() } : {}),
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

function expectIssue(res: Res, path: readonly string[], code: string) {
  expectProblem(res, 422, "validation_failed");
  const body = JSON.parse(res.body) as {
    issues: { path: string[]; code: string }[];
  };
  expect(body.issues).toContainEqual(
    expect.objectContaining({ path: [...path], code }),
  );
}

/** A new organisation through the API; its creator is the owner. */
async function newOrg() {
  const sub = newSub();
  const res = await call({ sub }, "POST", "/v1/organizations", {
    slug: `pj-${String(next())}`,
    legalName: "Projects Ltd",
    country: "SL",
    defaultCurrency: "SLE",
    defaultLanguage: "en",
    timezone: "Africa/Freetown",
  });
  expect(res.statusCode, res.body).toBe(201);
  const org = Organization.schema.parse(JSON.parse(res.body));
  return { org: org.id, owner: { sub, org: org.id } };
}

/** A member of `org` with `role` (and project memberships). */
async function member(
  org: string,
  role: string,
  projects: readonly string[] = [],
): Promise<Caller & { userId: string }> {
  const sub = newSub();
  await call({ sub, org }, "GET", "/v1/me/memberships");
  const [row] = await asAdmin<{ id: string }>(
    "SELECT id::text FROM bricx.users WHERE keycloak_sub = $1",
    [sub],
  );
  if (row === undefined) throw new Error("no users row");
  await applyAccess(asAdmin, { orgId: org, userId: row.id, role, projects });
  return { sub, org, userId: row.id };
}

const CCW = [
  [-13.24, 8.48],
  [-13.23, 8.48],
  [-13.23, 8.49],
  [-13.24, 8.49],
  [-13.24, 8.48],
];
const boundary = (ring: number[][] = CCW) => ({
  type: "Polygon",
  coordinates: [ring],
});

async function createProject(who: Caller, body: Record<string, unknown> = {}) {
  const res = await call(who, "POST", "/v1/projects", {
    code: `PRJ-${String(next())}`,
    name: "Lumley bridge",
    ...body,
  });
  expect(res.statusCode, res.body).toBe(201);
  return Project.schema.parse(JSON.parse(res.body));
}

async function createSite(
  who: Caller,
  projectId: string,
  body: Record<string, unknown> = {},
) {
  const res = await call(who, "POST", `/v1/projects/${projectId}/sites`, {
    name: "North yard",
    boundary: boundary(),
    ...body,
  });
  expect(res.statusCode, res.body).toBe(201);
  return Site.schema.parse(JSON.parse(res.body));
}

async function moveTo(who: Caller, projectId: string, to: string) {
  return call(who, "POST", `/v1/projects/${projectId}/status`, { to });
}

const auditOf = (org: string, entityType: string) =>
  asAdmin<{
    action: string;
    entity_id: string;
    after: unknown;
    before: unknown;
  }>(
    `SELECT action, entity_id::text, before, after FROM bricx.audit_events
     WHERE org_id = $1 AND entity_type = $2 ORDER BY seq`,
    [org, entityType],
  );

describe("projects: create and read (Done-when 1 and 2)", () => {
  test("the owner creates a draft project; currency, reporting currency and timezone default from the effective org config; nobody becomes a member (D7)", async () => {
    const { org, owner } = await newOrg();
    const project = await createProject(owner, {
      clientName: "Ministry of Works",
    });
    expect(project).toMatchObject({
      code: expect.stringMatching(/^PRJ-/) as string,
      name: "Lumley bridge",
      clientName: "Ministry of Works",
      status: "draft",
      currency: "SLE",
      reportingCurrency: "SLE",
      timezone: "Africa/Freetown",
      startDate: null,
      endDate: null,
      contractValue: null,
      archivedAt: null,
    });
    const members = await call(
      owner,
      "GET",
      `/v1/projects/${project.id}/members`,
    );
    expect(members.statusCode, members.body).toBe(200);
    expect(JSON.parse(members.body)).toEqual({ items: [] });
    const got = await call(owner, "GET", `/v1/projects/${project.id}`);
    expect(Project.schema.parse(JSON.parse(got.body))).toEqual(project);
    const audit = await auditOf(org, "project.project");
    expect(audit.map((a) => a.action)).toEqual(["project.project.create"]);
  });

  test("explicit currency, reporting currency, timezone and dates; start after end is 422", async () => {
    const { owner } = await newOrg();
    const project = await createProject(owner, {
      currency: "USD",
      reportingCurrency: "EUR",
      timezone: "Africa/Lagos",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });
    expect(project).toMatchObject({
      currency: "USD",
      reportingCurrency: "EUR",
      timezone: "Africa/Lagos",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });
    const bad = await call(owner, "POST", "/v1/projects", {
      code: "BAD-1",
      name: "x",
      startDate: "2026-02-01",
      endDate: "2026-01-01",
    });
    expectIssue(bad, ["endDate"], "invalid_value");
    for (const [field, value] of [
      ["currency", "XXX"],
      ["reportingCurrency", "SLL"],
      ["timezone", "Mars/Olympus"],
    ] as const) {
      const res = await call(owner, "POST", "/v1/projects", {
        code: `BAD-${field}`,
        name: "x",
        [field]: value,
      });
      expect(res.statusCode, `${field} ${res.body}`).toBe(422);
      expect(res.body).not.toContain(value);
    }
  });

  test.each([
    ["A", true],
    ["p-01", true],
    ["BR.2026_x-1", true],
    [`A${"b".repeat(31)}`, true],
    [`A${"b".repeat(32)}`, false],
    ["-A", false],
    ["A B", false],
    ["", false],
  ])("code %j valid: %s (C7)", async (code, valid) => {
    const { owner } = await newOrg();
    const res = await call(owner, "POST", "/v1/projects", { code, name: "x" });
    if (valid) expect(res.statusCode, res.body).toBe(201);
    else expectIssue(res, ["code"], "invalid_value");
  });

  test("the code is unique per org regardless of case: 409; another org may reuse it (Done-when 6, C7)", async () => {
    const { owner } = await newOrg();
    const other = await newOrg();
    await createProject(owner, { code: "Bridge-7" });
    expectProblem(
      await call(owner, "POST", "/v1/projects", {
        code: "BRIDGE-7",
        name: "x",
      }),
      409,
      "request.conflict",
    );
    await createProject(other.owner, { code: "bridge-7" });
    const second = await createProject(owner, { code: "Bridge-8" });
    expectProblem(
      await call(owner, "PATCH", `/v1/projects/${second.id}`, {
        code: "bridge-7",
      }),
      409,
      "request.conflict",
    );
  });

  test("project.project.create is org scope only: a project manager cannot create (403)", async () => {
    const { org, owner } = await newOrg();
    const project = await createProject(owner);
    const pm = await member(org, "project_manager", [project.id]);
    expectProblem(
      await call(pm, "POST", "/v1/projects", { code: "PM-1", name: "x" }),
      403,
      "forbidden",
    );
  });
});

describe("isolation (Done-when 1, C5)", () => {
  test("a project member of A gets the same 404 on B as on an unknown id; lists hold only their projects; another org sees none", async () => {
    const { org, owner } = await newOrg();
    const a = await createProject(owner);
    const b = await createProject(owner);
    const pm = await member(org, "project_manager", [a.id]);
    expect((await call(pm, "GET", `/v1/projects/${a.id}`)).statusCode).toBe(
      200,
    );
    const onB = await call(pm, "GET", `/v1/projects/${b.id}`);
    const onUnknown = await call(
      pm,
      "GET",
      "/v1/projects/0199e1d7-0000-7000-8000-000000000999",
    );
    expectProblem(onB, 404, "not_found");
    expectProblem(onUnknown, 404, "not_found");
    expect(JSON.parse(onB.body)).toEqual({
      ...JSON.parse(onUnknown.body),
      traceId: expect.any(String) as string,
    });
    expectProblem(
      await call(pm, "PATCH", `/v1/projects/${b.id}`, { name: "x" }),
      404,
      "not_found",
    );
    expectProblem(await moveTo(pm, b.id, "active"), 404, "not_found");
    expectProblem(
      await call(pm, "GET", `/v1/projects/${b.id}/sites`),
      404,
      "not_found",
    );
    const list = ProjectPage.schema.parse(
      JSON.parse((await call(pm, "GET", "/v1/projects")).body),
    );
    expect(list.items.map((p) => p.id)).toEqual([a.id]);
    // Another organisation's owner sees none of it.
    const other = await newOrg();
    expectProblem(
      await call(other.owner, "GET", `/v1/projects/${a.id}`),
      404,
      "not_found",
    );
    const theirs = ProjectPage.schema.parse(
      JSON.parse((await call(other.owner, "GET", "/v1/projects")).body),
    );
    expect(theirs.items).toEqual([]);
  });

  test("an org-scope reader (accountant) lists every project of the org", async () => {
    const { org, owner } = await newOrg();
    const a = await createProject(owner);
    const b = await createProject(owner);
    const accountant = await member(org, "accountant");
    const list = ProjectPage.schema.parse(
      JSON.parse((await call(accountant, "GET", "/v1/projects")).body),
    );
    expect(list.items.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("lists are keyset-paged by id, newest first; a status filter; a bad cursor is 422 (C5)", async () => {
    const { owner } = await newOrg();
    const made = [];
    for (let i = 0; i < 5; i += 1) made.push(await createProject(owner));
    const newestFirst = made.map((p) => p.id).reverse();
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/v1/projects?limit=2${cursor === null ? "" : `&cursor=${cursor}`}`;
      const res = await call(owner, "GET", url);
      expect(res.statusCode, res.body).toBe(200);
      const page = ProjectPage.schema.parse(JSON.parse(res.body));
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((p) => p.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(newestFirst);
    const first = made[0];
    if (first === undefined) throw new Error("none made");
    expect((await moveTo(owner, first.id, "active")).statusCode).toBe(200);
    const active = ProjectPage.schema.parse(
      JSON.parse((await call(owner, "GET", "/v1/projects?status=active")).body),
    );
    expect(active.items.map((p) => p.id)).toEqual([first.id]);
    expect(
      (await call(owner, "GET", "/v1/projects?cursor=%25%25")).statusCode,
    ).toBe(422);
    expect(
      (await call(owner, "GET", "/v1/projects?limit=101")).statusCode,
    ).toBe(422);
    expect(
      (await call(owner, "GET", "/v1/projects?status=closed")).statusCode,
    ).toBe(422);
  });
});

describe("the contract value (Done-when 2, C8)", () => {
  test("round-trips as a minor-unit string with its own currency; only update-key holders see it; others get null", async () => {
    const { org, owner } = await newOrg();
    const project = await createProject(owner, {
      contractValue: { amount: "123456789012", currency: "USD" },
    });
    expect(project.contractValue).toEqual({
      amount: "123456789012",
      currency: "USD",
    });
    const [row] = await asAdmin<{ minor: string; currency: string }>(
      "SELECT contract_value_minor::text AS minor, contract_value_currency AS currency FROM bricx.projects WHERE id = $1",
      [project.id],
    );
    expect(row).toEqual({ minor: "123456789012", currency: "USD" });
    const pm = await member(org, "project_manager", [project.id]);
    const qs = await member(org, "quantity_surveyor", [project.id]);
    const accountant = await member(org, "accountant");
    const read = async (who: Caller) =>
      Project.schema.parse(
        JSON.parse((await call(who, "GET", `/v1/projects/${project.id}`)).body),
      ).contractValue;
    expect(await read(pm)).toEqual({ amount: "123456789012", currency: "USD" });
    expect(await read(qs)).toBeNull();
    expect(await read(accountant)).toBeNull();
    const listed = ProjectPage.schema.parse(
      JSON.parse((await call(accountant, "GET", "/v1/projects")).body),
    );
    expect(listed.items[0]?.contractValue).toBeNull();
    // Writing it needs the update key too (the PM holds it on the project).
    const changed = await call(pm, "PATCH", `/v1/projects/${project.id}`, {
      contractValue: { amount: "5000", currency: "SLE" },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(
      Project.schema.parse(JSON.parse(changed.body)).contractValue,
    ).toEqual({
      amount: "5000",
      currency: "SLE",
    });
    // Cleared with null.
    const cleared = await call(owner, "PATCH", `/v1/projects/${project.id}`, {
      contractValue: null,
    });
    expect(
      Project.schema.parse(JSON.parse(cleared.body)).contractValue,
    ).toBeNull();
    // The audit never holds an amount.
    const audit = JSON.stringify(await auditOf(org, "project.project"));
    expect(audit).toContain("contractValue");
    expect(audit).not.toContain("123456789012");
    expect(audit).not.toContain("5000");
  });

  test("MoneySchema at the boundary: a negative amount, too many digits, a float, a currency without a minor unit are 422 and echo nothing", async () => {
    const { owner } = await newOrg();
    for (const contractValue of [
      { amount: "-1", currency: "USD" },
      { amount: "1.5", currency: "USD" },
      { amount: 100, currency: "USD" },
      { amount: "99999999999999999999", currency: "USD" },
      { amount: "1", currency: "XAU" },
      { amount: "1", currency: "SLL" },
      { amount: "1" },
    ]) {
      const res = await call(owner, "POST", "/v1/projects", {
        code: `CV-${String(next())}`,
        name: "x",
        contractValue,
      });
      expect(
        res.statusCode,
        `${JSON.stringify(contractValue)} ${res.body}`,
      ).toBe(422);
      expect(res.body).not.toContain("99999999999999999999");
    }
  });

  test("a creator without the update key cannot set it (403); a reader cannot change it", async () => {
    const { org, owner } = await newOrg();
    const project = await createProject(owner);
    const qs = await member(org, "quantity_surveyor", [project.id]);
    expectProblem(
      await call(qs, "PATCH", `/v1/projects/${project.id}`, {
        contractValue: { amount: "1", currency: "USD" },
      }),
      403,
      "forbidden",
    );
  });
});

describe("update and the currency lock (C1)", () => {
  test("an empty PATCH is 422; a no-change PATCH is 200 with no audit event; a change records one event naming the fields", async () => {
    const { org, owner } = await newOrg();
    const project = await createProject(owner, {
      name: "Before",
      clientName: "Ministry of Works",
    });
    expectProblem(
      await call(owner, "PATCH", `/v1/projects/${project.id}`, {}),
      422,
      "validation_failed",
    );
    expect(
      (
        await call(owner, "PATCH", `/v1/projects/${project.id}`, {
          name: "Before",
        })
      ).statusCode,
    ).toBe(200);
    const changed = await call(owner, "PATCH", `/v1/projects/${project.id}`, {
      name: "After",
      clientName: null,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const audit = await auditOf(org, "project.project");
    expect(audit.map((a) => a.action)).toEqual([
      "project.project.create",
      "project.project.update",
    ]);
    expect(audit[1]?.after).toEqual({ fields: ["clientName", "name"] });
  });

  test.each([
    ["currency", "USD"],
    ["reportingCurrency", "EUR"],
    ["timezone", "Africa/Lagos"],
  ])(
    "%s changes in draft; once the project is active, on hold or completed it is 409",
    async (field, value) => {
      const { owner } = await newOrg();
      const project = await createProject(owner);
      const inDraft = await call(owner, "PATCH", `/v1/projects/${project.id}`, {
        [field]: value,
      });
      expect(inDraft.statusCode, inDraft.body).toBe(200);
      expect(JSON.parse(inDraft.body)).toMatchObject({ [field]: value });
      const other = field === "timezone" ? "Africa/Accra" : "GHS";
      expect((await moveTo(owner, project.id, "active")).statusCode).toBe(200);
      expectProblem(
        await call(owner, "PATCH", `/v1/projects/${project.id}`, {
          [field]: other,
        }),
        409,
        "request.conflict",
      );
      // The same value is no change, so it passes.
      expect(
        (
          await call(owner, "PATCH", `/v1/projects/${project.id}`, {
            [field]: value,
          })
        ).statusCode,
      ).toBe(200);
      expect((await moveTo(owner, project.id, "on_hold")).statusCode).toBe(200);
      expectProblem(
        await call(owner, "PATCH", `/v1/projects/${project.id}`, {
          [field]: other,
        }),
        409,
        "request.conflict",
      );
      // Other fields still change.
      expect(
        (
          await call(owner, "PATCH", `/v1/projects/${project.id}`, {
            name: "Renamed",
          })
        ).statusCode,
      ).toBe(200);
    },
  );
});

describe("the status machine (Done-when 3, C3)", () => {
  const RULED: Record<string, string[]> = {
    draft: ["active", "archived"],
    active: ["on_hold", "completed"],
    on_hold: ["active", "completed"],
    completed: ["archived"],
    archived: [],
  };
  const STATUSES = ["draft", "active", "on_hold", "completed", "archived"];
  /** A path from draft to `status` through allowed moves. */
  const PATHS: Record<string, string[]> = {
    draft: [],
    active: ["active"],
    on_hold: ["active", "on_hold"],
    completed: ["active", "completed"],
    archived: ["archived"],
  };

  test.each(STATUSES.flatMap((from) => STATUSES.map((to) => [from, to])))(
    "%s -> %s through the API follows the ruling",
    async (from, to) => {
      const { owner } = await newOrg();
      const project = await createProject(owner);
      for (const step of PATHS[from] ?? []) {
        expect((await moveTo(owner, project.id, step)).statusCode).toBe(200);
      }
      const res = await moveTo(owner, project.id, to);
      if ((RULED[from] ?? []).includes(to)) {
        expect(res.statusCode, res.body).toBe(200);
        const moved = Project.schema.parse(JSON.parse(res.body));
        expect(moved.status).toBe(to);
        expect(moved.archivedAt === null).toBe(to !== "archived");
      } else {
        expectProblem(res, 409, "request.conflict");
      }
    },
  );

  test("archive needs project.project.archive; other moves project.project.update (a project manager may move, not archive)", async () => {
    const { org, owner } = await newOrg();
    const project = await createProject(owner);
    const pm = await member(org, "project_manager", [project.id]);
    const po = await member(org, "project_owner", [project.id]);
    const qs = await member(org, "quantity_surveyor", [project.id]);
    expectProblem(await moveTo(qs, project.id, "active"), 403, "forbidden");
    expect((await moveTo(pm, project.id, "active")).statusCode).toBe(200);
    expect((await moveTo(pm, project.id, "completed")).statusCode).toBe(200);
    expectProblem(await moveTo(pm, project.id, "archived"), 403, "forbidden");
    expect((await moveTo(po, project.id, "archived")).statusCode).toBe(200);
  });

  test("each move records one audit event with before and after status", async () => {
    const { org, owner } = await newOrg();
    const project = await createProject(owner);
    await moveTo(owner, project.id, "active");
    const audit = await auditOf(org, "project.project");
    expect(audit.at(-1)).toMatchObject({
      action: "project.project.status",
      before: { status: "draft" },
      after: { status: "active" },
    });
  });

  test("an archived project is read-only: PATCH, site create, update and archive are 409; reads still work", async () => {
    const { owner } = await newOrg();
    const project = await createProject(owner);
    const site = await createSite(owner, project.id);
    expect((await moveTo(owner, project.id, "archived")).statusCode).toBe(200);
    expectProblem(
      await call(owner, "PATCH", `/v1/projects/${project.id}`, { name: "x" }),
      409,
      "request.conflict",
    );
    expectProblem(
      await call(owner, "POST", `/v1/projects/${project.id}/sites`, {
        name: "x",
        boundary: boundary(),
      }),
      409,
      "request.conflict",
    );
    expectProblem(
      await call(
        owner,
        "PATCH",
        `/v1/projects/${project.id}/sites/${site.id}`,
        { name: "x" },
      ),
      409,
      "request.conflict",
    );
    expectProblem(
      await call(
        owner,
        "POST",
        `/v1/projects/${project.id}/sites/${site.id}/archive`,
      ),
      409,
      "request.conflict",
    );
    expect(
      (await call(owner, "GET", `/v1/projects/${project.id}`)).statusCode,
    ).toBe(200);
    expect(
      (await call(owner, "GET", `/v1/projects/${project.id}/sites/${site.id}`))
        .statusCode,
    ).toBe(200);
  });
});

describe("sites (Done-when 1 and 4, C6)", () => {
  test("create, read, list, update and archive; the boundary comes back counter-clockwise", async () => {
    const { org, owner } = await newOrg();
    const project = await createProject(owner);
    const site = await createSite(owner, project.id, {
      address: "Lumley Beach Road",
      geofenceRadiusM: 250,
    });
    expect(site).toMatchObject({
      projectId: project.id,
      name: "North yard",
      boundary: boundary(),
      address: "Lumley Beach Road",
      geofenceRadiusM: 250,
      archivedAt: null,
    });
    const listed = SitePage.schema.parse(
      JSON.parse(
        (await call(owner, "GET", `/v1/projects/${project.id}/sites`)).body,
      ),
    );
    expect(listed.items.map((s) => s.id)).toEqual([site.id]);
    const updated = await call(
      owner,
      "PATCH",
      `/v1/projects/${project.id}/sites/${site.id}`,
      {
        name: "South yard",
        geofenceRadiusM: 0,
      },
    );
    expect(updated.statusCode, updated.body).toBe(200);
    const archived = await call(
      owner,
      "POST",
      `/v1/projects/${project.id}/sites/${site.id}/archive`,
    );
    expect(archived.statusCode, archived.body).toBe(200);
    expect(
      Site.schema.parse(JSON.parse(archived.body)).archivedAt,
    ).not.toBeNull();
    expectProblem(
      await call(
        owner,
        "PATCH",
        `/v1/projects/${project.id}/sites/${site.id}`,
        { name: "x" },
      ),
      409,
      "request.conflict",
    );
    expectProblem(
      await call(
        owner,
        "POST",
        `/v1/projects/${project.id}/sites/${site.id}/archive`,
      ),
      409,
      "request.conflict",
    );
    const audit = await auditOf(org, "project.site");
    expect(audit.map((a) => a.action)).toEqual([
      "project.site.create",
      "project.site.update",
      "project.site.archive",
    ]);
    expect(audit[1]?.after).toEqual({ fields: ["geofenceRadiusM", "name"] });
  });

  test("CW and CCW input of the same polygon store identically (C6)", async () => {
    const { owner } = await newOrg();
    const project = await createProject(owner);
    const ccw = await createSite(owner, project.id, {
      boundary: boundary(CCW),
    });
    const cw = await createSite(owner, project.id, {
      boundary: boundary([...CCW].reverse()),
    });
    expect(cw.boundary).toEqual(ccw.boundary);
    const stored = await asAdmin<{ same: boolean }>(
      `SELECT extensions.ST_AsBinary(a.geom) = extensions.ST_AsBinary(b.geom) AS same
       FROM bricx.sites a, bricx.sites b WHERE a.id = $1 AND b.id = $2`,
      [ccw.id, cw.id],
    );
    expect(stored).toEqual([{ same: true }]);
  });

  test("a self-intersecting boundary is 422 invalid_polygon; one over 1 000 km² is 422 polygon_too_large; never a 500, nothing written", async () => {
    const { org, owner } = await newOrg();
    const project = await createProject(owner);
    const bowTie = await call(
      owner,
      "POST",
      `/v1/projects/${project.id}/sites`,
      {
        name: "x",
        boundary: boundary([
          [-13.24, 8.48],
          [-13.23, 8.49],
          [-13.23, 8.48],
          [-13.24, 8.49],
          [-13.24, 8.48],
        ]),
      },
    );
    expectIssue(bowTie, ["boundary"], "invalid_polygon");
    const huge = await call(owner, "POST", `/v1/projects/${project.id}/sites`, {
      name: "x",
      boundary: boundary([
        [-13.5, 8.0],
        [-12.5, 8.0],
        [-12.5, 9.0],
        [-13.5, 9.0],
        [-13.5, 8.0],
      ]),
    });
    expectIssue(huge, ["boundary"], "polygon_too_large");
    const unclosed = await call(
      owner,
      "POST",
      `/v1/projects/${project.id}/sites`,
      {
        name: "x",
        boundary: boundary(CCW.slice(0, 4)),
      },
    );
    expectIssue(unclosed, ["boundary"], "invalid_polygon");
    const site = await createSite(owner, project.id);
    expectIssue(
      await call(
        owner,
        "PATCH",
        `/v1/projects/${project.id}/sites/${site.id}`,
        {
          boundary: boundary([
            [-13.5, 8.0],
            [-12.5, 8.0],
            [-12.5, 9.0],
            [-13.5, 9.0],
            [-13.5, 8.0],
          ]),
        },
      ),
      ["boundary"],
      "polygon_too_large",
    );
    expect(
      await asAdmin(
        "SELECT count(*)::int AS n FROM bricx.sites WHERE org_id = $1",
        [org],
      ),
    ).toEqual([{ n: 1 }]);
  });

  test.each([
    [{ geofenceRadiusM: -1 }, ["geofenceRadiusM"]],
    [{ geofenceRadiusM: 10_001 }, ["geofenceRadiusM"]],
    [{ geofenceRadiusM: 1.5 }, ["geofenceRadiusM"]],
    [{ name: "" }, ["name"]],
    [{ address: "x".repeat(501) }, ["address"]],
  ])("%j is 422 at %j", async (body, path) => {
    const { owner } = await newOrg();
    const project = await createProject(owner);
    const res = await call(owner, "POST", `/v1/projects/${project.id}/sites`, {
      name: "x",
      boundary: boundary(),
      ...body,
    });
    expectProblem(res, 422, "validation_failed");
    const issues = (JSON.parse(res.body) as { issues: { path: string[] }[] })
      .issues;
    expect(issues.map((i) => i.path)).toContainEqual(path);
  });

  test("site keys: a quantity surveyor reads the project's sites but cannot create one; a site of another project is 404 under this one", async () => {
    const { org, owner } = await newOrg();
    const a = await createProject(owner);
    const b = await createProject(owner);
    const siteB = await createSite(owner, b.id);
    const qs = await member(org, "quantity_surveyor", [a.id]);
    expect(
      (await call(qs, "GET", `/v1/projects/${a.id}/sites`)).statusCode,
    ).toBe(200);
    expectProblem(
      await call(qs, "POST", `/v1/projects/${a.id}/sites`, {
        name: "x",
        boundary: boundary(),
      }),
      403,
      "forbidden",
    );
    expectProblem(
      await call(owner, "GET", `/v1/projects/${a.id}/sites/${siteB.id}`),
      404,
      "not_found",
    );
  });
});
