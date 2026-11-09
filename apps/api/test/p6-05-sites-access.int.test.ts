// P6-05 (ADR 0075 D15, D16; owner conditions C4 and C9): who holds site
// keys, end to end against Postgres with the production journal, through
// the real app and the production DbGrantsSource. A test-only probe
// controller shows the identity's grants as the guard built them.
// C4:
// - a project membership's siteIds (POST and PATCH): sorted, unique, each
//   an open site of that project, else 422 unknown_site; the response
//   carries them;
// - empty siteIds = no site keys: the member's site-scope keys grant
//   nothing; assigned sites give site grants on exactly those sites;
// - DbGrantsSource drops site keys on an archived site except read;
// - a membership POST or PATCH on an archived project is 409; removal
//   still works.
// C9:
// - POST /v1/access-grants takes siteId: a site key needs scopeId and
//   siteId, the site in that project (else 422 at siteId); a project or
//   org key with a siteId is 422; the row, the response and the audit
//   event carry siteId; the elevation is a site grant on that site;
// - removing the member from the project ends their site elevations
//   there too (endAccessGrantsOf by scope_id).
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
import { Controller, Get } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { NoPermission } from "../src/common/auth/can.decorator.js";
import { currentRequestContext } from "../src/common/db/request-context.js";
import { Organization } from "../src/modules/organizations/organizations.dto.js";
import { Project } from "../src/modules/projects/projects.dto.js";
import { Site } from "../src/modules/projects/sites.dto.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";
import {
  TestIssuer,
  applyAccess,
  bearer,
  fixedRevocations,
} from "./support/auth.js";
import { memoryRateLimits } from "./support/rate-limit.js";

const HOOK_MS = 300_000;

@NoPermission("test-only probe")
@Controller({ path: "p605-whoami", version: "1" })
class GrantsProbeController {
  @Get()
  get() {
    const identity = currentRequestContext()?.identity;
    return {
      grants: identity?.grants ?? [],
      projectIds: identity?.projectIds ?? [],
    };
  }
}

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
        CELL_ID: "af-south-1",
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
      extraControllers: [GrantsProbeController],
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
type Res = Awaited<ReturnType<NestFastifyApplication["inject"]>>;
interface Caller {
  readonly sub: string;
  readonly org?: string;
  readonly userId?: string;
}

async function call(
  // The acr claim: mfa unless a test says otherwise.
  who: Caller & { readonly acr?: string },
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
): Promise<Res> {
  const token = await issuer.token({
    sub: who.sub,
    org_id: who.org,
    // P6-05e (ADR 0081): admin keys need acr mfa, so the fixture signs mfa
    // unless a test passes acr (the pwd step-up case below).
    acr: who.acr ?? "mfa",
  });
  return app.inject({
    method,
    url,
    headers: {
      ...bearer(token),
      ...(method === "POST"
        ? { "idempotency-key": `p605-${String(next()).padStart(8, "0")}` }
        : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

function expectProblem(res: Res, status: number, code: string) {
  expect(res.statusCode, res.body).toBe(status);
  const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(res.body));
  expect(parsed.success).toBe(true);
  expect(parsed.data).toMatchObject({ status, code });
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

const SQUARE = {
  type: "Polygon",
  coordinates: [
    [
      [-13.24, 8.48],
      [-13.23, 8.48],
      [-13.23, 8.49],
      [-13.24, 8.49],
      [-13.24, 8.48],
    ],
  ],
};

async function newOrg() {
  const sub = `p605-owner-${String(next())}`;
  const res = await call({ sub }, "POST", "/v1/organizations", {
    slug: `p605-${String(next())}`,
    legalName: "Sites Ltd",
    country: "SL",
    defaultCurrency: "SLE",
    defaultLanguage: "en",
    timezone: "Africa/Freetown",
  });
  expect(res.statusCode, res.body).toBe(201);
  const org = Organization.schema.parse(JSON.parse(res.body));
  return { org: org.id, owner: { sub, org: org.id } };
}

/** A user of `org` (provisioned) with an org membership and `role`. */
async function person(org: string, role: string): Promise<Required<Caller>> {
  const sub = `p605-user-${String(next())}`;
  await call({ sub, org }, "GET", "/v1/me/memberships");
  const [row] = await asAdmin<{ id: string }>(
    "SELECT id::text FROM bricx.users WHERE keycloak_sub = $1",
    [sub],
  );
  if (row === undefined) throw new Error("no users row");
  await applyAccess(asAdmin, { orgId: org, userId: row.id, role });
  return { sub, org, userId: row.id };
}

const roleId = async (org: string, key: string) => {
  const [row] = await asAdmin<{ id: string }>(
    "SELECT id::text FROM bricx.roles WHERE org_id = $1 AND system_key = $2 AND archived_at IS NULL",
    [org, key],
  );
  if (row === undefined) throw new Error(`no ${key} role`);
  return row.id;
};

async function project(owner: Caller) {
  const res = await call(owner, "POST", "/v1/projects", {
    code: `S-${String(next())}`,
    name: "Site project",
  });
  expect(res.statusCode, res.body).toBe(201);
  return Project.schema.parse(JSON.parse(res.body));
}

async function site(owner: Caller, projectId: string) {
  const res = await call(owner, "POST", `/v1/projects/${projectId}/sites`, {
    name: `Site ${String(next())}`,
    boundary: SQUARE,
  });
  expect(res.statusCode, res.body).toBe(201);
  return Site.schema.parse(JSON.parse(res.body));
}

async function assign(
  owner: Caller,
  projectId: string,
  user: string,
  role: string,
  siteIds?: readonly string[],
  overrides?: unknown,
) {
  return call(owner, "POST", `/v1/projects/${projectId}/members`, {
    userId: user,
    roleId: role,
    ...(siteIds === undefined ? {} : { siteIds }),
    ...(overrides === undefined ? {} : { overrides }),
  });
}

interface ProbeGrant {
  permission: string;
  scope: string;
  siteIds?: string[];
  projectIds?: string[];
}
const grantsOf = async (who: Caller) => {
  const res = await call(who, "GET", "/v1/p605-whoami");
  expect(res.statusCode, res.body).toBe(200);
  return (JSON.parse(res.body) as { grants: ProbeGrant[] }).grants;
};
const siteGrants = async (who: Caller) =>
  (await grantsOf(who)).filter((g) => g.scope === "site");

describe("site assignment (C4)", () => {
  test("siteIds on POST: sorted, carried in the response; the site keys hold on exactly those sites", async () => {
    const { org, owner } = await newOrg();
    const p = await project(owner);
    const s1 = await site(owner, p.id);
    const s2 = await site(owner, p.id);
    const engineer = await person(org, "member");
    const res = await assign(
      owner,
      p.id,
      engineer.userId,
      await roleId(org, "site_engineer"),
      [s2.id, s1.id].reverse(),
    );
    expect(res.statusCode, res.body).toBe(201);
    expect(JSON.parse(res.body)).toMatchObject({
      siteIds: [s1.id, s2.id].sort(),
    });
    const grants = await siteGrants(engineer);
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) expect(g.siteIds).toEqual([s1.id, s2.id].sort());
    // The engineer reads those sites, through the site route.
    expect(
      (await call(engineer, "GET", `/v1/projects/${p.id}/sites/${s1.id}`))
        .statusCode,
    ).toBe(200);
  });

  test("empty siteIds = no site keys; the project keys stay; the engineer then reads no site", async () => {
    const { org, owner } = await newOrg();
    const p = await project(owner);
    const s1 = await site(owner, p.id);
    const engineer = await person(org, "member");
    const res = await assign(
      owner,
      p.id,
      engineer.userId,
      await roleId(org, "site_engineer"),
      [s1.id],
    );
    const membership = JSON.parse(res.body) as { id: string };
    expect(await siteGrants(engineer)).not.toEqual([]);
    const cleared = await call(
      owner,
      "PATCH",
      `/v1/projects/${p.id}/members/${membership.id}`,
      {
        siteIds: [],
      },
    );
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(JSON.parse(cleared.body)).toMatchObject({ siteIds: [] });
    expect(await siteGrants(engineer)).toEqual([]);
    expect((await grantsOf(engineer)).some((g) => g.scope === "project")).toBe(
      true,
    );
    expectProblem(
      await call(engineer, "GET", `/v1/projects/${p.id}/sites/${s1.id}`),
      404,
      "not_found",
    );
    // Absent siteIds on POST is empty too.
    const other = await person(org, "member");
    await assign(owner, p.id, other.userId, await roleId(org, "site_engineer"));
    expect(await siteGrants(other)).toEqual([]);
  });

  test("a site of another project, an unknown site, an archived site and a duplicate are 422 at siteIds; nothing written", async () => {
    const { org, owner } = await newOrg();
    const p = await project(owner);
    const q = await project(owner);
    const s1 = await site(owner, p.id);
    const elsewhere = await site(owner, q.id);
    const archived = await site(owner, p.id);
    expect(
      (
        await call(
          owner,
          "POST",
          `/v1/projects/${p.id}/sites/${archived.id}/archive`,
        )
      ).statusCode,
    ).toBe(200);
    const engineer = await person(org, "member");
    const role = await roleId(org, "site_engineer");
    for (const siteIds of [
      [elsewhere.id],
      ["0199e1d8-0000-7000-8000-000000000001"],
      [archived.id],
    ]) {
      expectIssue(
        await assign(owner, p.id, engineer.userId, role, siteIds),
        ["siteIds"],
        "unknown_site",
      );
    }
    expectIssue(
      await assign(owner, p.id, engineer.userId, role, [s1.id, s1.id]),
      ["siteIds"],
      "invalid_value",
    );
    expect(
      await asAdmin(
        "SELECT count(*)::int AS n FROM bricx.project_memberships WHERE user_id = $1 AND removed_at IS NULL",
        [engineer.userId],
      ),
    ).toEqual([{ n: 0 }]);
  });

  test("an archived site keeps read keys only (DbGrantsSource)", async () => {
    const { org, owner } = await newOrg();
    const p = await project(owner);
    const s1 = await site(owner, p.id);
    const engineer = await person(org, "member");
    const res = await assign(
      owner,
      p.id,
      engineer.userId,
      await roleId(org, "site_engineer"),
      [s1.id],
    );
    expect(res.statusCode, res.body).toBe(201);
    const before = await siteGrants(engineer);
    expect(before.some((g) => !g.permission.endsWith(".read"))).toBe(true);
    expect(
      (await call(owner, "POST", `/v1/projects/${p.id}/sites/${s1.id}/archive`))
        .statusCode,
    ).toBe(200);
    const after = await siteGrants(engineer);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((g) => g.permission.endsWith(".read"))).toBe(true);
    expect(after.map((g) => g.permission).sort()).toEqual(
      before
        .map((g) => g.permission)
        .filter((p2) => p2.endsWith(".read"))
        .sort(),
    );
    expect(
      (await call(engineer, "GET", `/v1/projects/${p.id}/sites/${s1.id}`))
        .statusCode,
    ).toBe(200);
  });

  test("on an archived project a membership POST or PATCH is 409; removal still works", async () => {
    const { org, owner } = await newOrg();
    const p = await project(owner);
    const engineer = await person(org, "member");
    const later = await person(org, "member");
    const role = await roleId(org, "site_engineer");
    const res = await assign(owner, p.id, engineer.userId, role);
    expect(res.statusCode, res.body).toBe(201);
    const membership = JSON.parse(res.body) as { id: string };
    expect(
      (
        await call(owner, "POST", `/v1/projects/${p.id}/status`, {
          to: "archived",
        })
      ).statusCode,
    ).toBe(200);
    expectProblem(
      await assign(owner, p.id, later.userId, role),
      409,
      "request.conflict",
    );
    expectProblem(
      await call(
        owner,
        "PATCH",
        `/v1/projects/${p.id}/members/${membership.id}`,
        { siteIds: [] },
      ),
      409,
      "request.conflict",
    );
    const removed = await call(
      owner,
      "DELETE",
      `/v1/projects/${p.id}/members/${membership.id}`,
    );
    expect(removed.statusCode, removed.body).toBeLessThan(300);
  });
});

describe("site elevations (C9)", () => {
  const window = () => ({
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    reason: "cover for the site engineer",
  });

  test("a site key with scopeId and siteId is a site grant on that site; row, response and audit carry siteId", async () => {
    const { org, owner } = await newOrg();
    const p = await project(owner);
    const s1 = await site(owner, p.id);
    const s2 = await site(owner, p.id);
    const qs = await person(org, "member");
    expect(
      (
        await assign(
          owner,
          p.id,
          qs.userId,
          await roleId(org, "quantity_surveyor"),
        )
      ).statusCode,
    ).toBe(201);
    const res = await call(owner, "POST", "/v1/access-grants", {
      userId: qs.userId,
      permission: "project.site.update.site",
      scopeId: p.id,
      siteId: s1.id,
      ...window(),
    });
    expect(res.statusCode, res.body).toBe(201);
    const granted = JSON.parse(res.body) as {
      id: string;
      siteId: string;
      scopeId: string;
    };
    expect(granted).toMatchObject({ scopeId: p.id, siteId: s1.id });
    expect(
      await asAdmin(
        "SELECT site_id::text FROM bricx.access_grants WHERE id = $1",
        [granted.id],
      ),
    ).toEqual([{ site_id: s1.id }]);
    const [event] = await asAdmin<{ after: { siteId?: string } }>(
      "SELECT after FROM bricx.audit_events WHERE entity_id = $1 AND action = 'org.access_grant.grant'",
      [granted.id],
    );
    expect(event?.after.siteId).toBe(s1.id);
    expect(await siteGrants(qs)).toContainEqual({
      permission: "project.site.update",
      scope: "site",
      siteIds: [s1.id],
    });
    // The grantee updates that site, not the other.
    expect(
      (
        await call(qs, "PATCH", `/v1/projects/${p.id}/sites/${s1.id}`, {
          name: "Renamed",
        })
      ).statusCode,
    ).toBe(200);
    expectProblem(
      await call(qs, "PATCH", `/v1/projects/${p.id}/sites/${s2.id}`, {
        name: "Renamed",
      }),
      403,
      "forbidden",
    );
    // GET lists it with siteId.
    const listed = await call(
      owner,
      "GET",
      `/v1/access-grants?userId=${qs.userId}`,
    );
    expect(JSON.parse(listed.body)).toMatchObject({
      items: [expect.objectContaining({ siteId: s1.id })],
    });
  });

  test.each([
    [
      "a site key without siteId",
      "project.site.update.site",
      true,
      false,
      ["siteId"],
    ],
    [
      "a site key without scopeId",
      "project.site.update.site",
      false,
      true,
      ["scopeId"],
    ],
    [
      "a project key with siteId",
      "project.project.update.project",
      true,
      true,
      ["siteId"],
    ],
    ["an org key with siteId", "org.member.read.org", false, true, ["siteId"]],
  ])(
    "%s is 422 at %j",
    async (_label, permission, withScope, withSite, path) => {
      const { org, owner } = await newOrg();
      const p = await project(owner);
      const s1 = await site(owner, p.id);
      const qs = await person(org, "member");
      await assign(
        owner,
        p.id,
        qs.userId,
        await roleId(org, "quantity_surveyor"),
      );
      const res = await call(owner, "POST", "/v1/access-grants", {
        userId: qs.userId,
        permission,
        ...(withScope ? { scopeId: p.id } : {}),
        ...(withSite ? { siteId: s1.id } : {}),
        ...window(),
      });
      expectIssue(res, path, "invalid_value");
    },
  );

  test("a site of another project, or an archived site, is 422 unknown_site at siteId", async () => {
    const { org, owner } = await newOrg();
    const p = await project(owner);
    const q = await project(owner);
    const elsewhere = await site(owner, q.id);
    const archived = await site(owner, p.id);
    await call(
      owner,
      "POST",
      `/v1/projects/${p.id}/sites/${archived.id}/archive`,
    );
    const qs = await person(org, "member");
    await assign(
      owner,
      p.id,
      qs.userId,
      await roleId(org, "quantity_surveyor"),
    );
    for (const siteId of [elsewhere.id, archived.id]) {
      expectIssue(
        await call(owner, "POST", "/v1/access-grants", {
          userId: qs.userId,
          permission: "project.site.update.site",
          scopeId: p.id,
          siteId,
          ...window(),
        }),
        ["siteId"],
        "unknown_site",
      );
    }
  });

  test("removing the member from the project ends their site elevations there", async () => {
    const { org, owner } = await newOrg();
    const p = await project(owner);
    const s1 = await site(owner, p.id);
    const qs = await person(org, "member");
    const assigned = await assign(
      owner,
      p.id,
      qs.userId,
      await roleId(org, "quantity_surveyor"),
    );
    const membership = JSON.parse(assigned.body) as { id: string };
    const res = await call(owner, "POST", "/v1/access-grants", {
      userId: qs.userId,
      permission: "project.site.update.site",
      scopeId: p.id,
      siteId: s1.id,
      ...window(),
    });
    const granted = JSON.parse(res.body) as { id: string };
    await call(
      owner,
      "DELETE",
      `/v1/projects/${p.id}/members/${membership.id}`,
    );
    const [row] = await asAdmin<{ ended: boolean }>(
      "SELECT revoked_at IS NOT NULL AS ended FROM bricx.access_grants WHERE id = $1",
      [granted.id],
    );
    expect(row).toEqual({ ended: true });
  });
});

describe("an admin key at acr pwd (P6-05e, ADR 0081)", () => {
  test("assigning a project member is 401 permission.step_up_required with the RFC 9470 challenge; the read stays 200 at pwd", async () => {
    const { owner } = await newOrg();
    const p = await project(owner);
    const pwd = { ...owner, acr: "pwd" };
    const refused = await call(pwd, "POST", `/v1/projects/${p.id}/members`, {});
    expectProblem(refused, 401, "permission.step_up_required");
    expect(refused.headers["www-authenticate"]).toBe(
      'Bearer error="insufficient_user_authentication", acr_values="mfa"',
    );
    const read = await call(pwd, "GET", `/v1/projects/${p.id}`);
    expect(read.statusCode, read.body).toBe(200);
  });
});
