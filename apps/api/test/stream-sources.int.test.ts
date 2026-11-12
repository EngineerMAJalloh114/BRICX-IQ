// P6-06b (ADR 0084; Done-when DW8; owner condition C1, CLAUDE.md rule 3;
// the owner's ruling on plan part 2: "views + DB leak test now"), against
// compose.yml's Postgres with the production journal. No PowerSync stream
// exists before P8-02; the generated sync-streams.yaml names two sources,
// app.user_project_access and app.user_grants_source (@bricx/permissions
// STREAM_SOURCES), and this suite proves about those views:
// - AGREEMENT: for every kind of active member (owner, custom org role,
//   project role with overrides, assigned sites, an external member, a
//   project and an org elevation) the view's rows are exactly what the
//   request path computes (the production grants source through the real
//   app, whoami), so a stream scope and an API answer cannot drift;
// - LEAK: a removed, a suspended and an expired org member, and a
//   suspended and an expired project membership, are in neither view, in
//   two orgs at once; an elevation of a suspended member is in neither;
//   the same holds read as bricx_app under RLS, where the other org's
//   rows are never visible either.
// The PowerSync end of this (a device stops receiving rows) is a
// Done-when of P8-02.
import { Writable } from "node:stream";
import { loadApiConfig } from "@bricx/config/api";
import {
  type BootstrappedPostgres,
  type StartedValkey,
  appDatabase,
  exampleValue,
  startPostgres,
  startValkey,
} from "@bricx/db-bootstrap/stack";
import { seedProjects } from "@bricx/db-bootstrap/fixtures";
import { type Database, openDatabase } from "@bricx/db/database";
import { migrate } from "@bricx/db/migrate";
import { parseCatalogueKey } from "@bricx/permissions/catalogue";
import { STREAM_SOURCES } from "@bricx/permissions/generate";
import { ROLES } from "@bricx/permissions/roles";
import { Controller, Get } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { NoPermission } from "../src/common/auth/can.decorator.js";
import { currentRequestContext } from "../src/common/db/request-context.js";
import { IDEMPOTENCY_KEY_HEADER } from "../src/common/idempotency/decorator.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";
import {
  TestIssuer,
  applyAccess,
  bearer,
  fixedRevocations,
  seedId,
  seedRole,
  seedUsers,
} from "./support/auth.js";
import { memoryRateLimits } from "./support/rate-limit.js";

const HOOK_MS = 300_000;
const ORG_A = "0199e1b3-0000-7000-8000-0000000000a1";
const ORG_B = "0199e1b3-0000-7000-8000-0000000000b1";
const P1 = "0199e1b3-0000-7000-8000-0000000000a3";
const P2 = "0199e1b3-0000-7000-8000-0000000000a4";
const P_B = "0199e1b3-0000-7000-8000-0000000000b3";
const users = {
  owner: "0199e1b3-0000-7000-8000-0000000000f1",
  ownerB: "0199e1b3-0000-7000-8000-0000000000f2",
  wide: "0199e1b3-0000-7000-8000-0000000000f3",
  manager: "0199e1b3-0000-7000-8000-0000000000f4",
  engineer: "0199e1b3-0000-7000-8000-0000000000f5",
  external: "0199e1b3-0000-7000-8000-0000000000f6",
  elevated: "0199e1b3-0000-7000-8000-0000000000f7",
  removed: "0199e1b3-0000-7000-8000-0000000000f8",
  suspended: "0199e1b3-0000-7000-8000-0000000000f9",
  expired: "0199e1b3-0000-7000-8000-0000000000fa",
  projectSuspended: "0199e1b3-0000-7000-8000-0000000000fb",
  projectExpired: "0199e1b3-0000-7000-8000-0000000000fc",
  both: "0199e1b3-0000-7000-8000-0000000000fd",
} as const;
const subOf = (user: string) => `streams-${user}`;
const WIDE_KEYS = [
  "org.region_config.read.org",
  "org.member.read.org",
  "project.milestone.read.org",
  "finance.budget.read.org",
  "project.task.read.own",
];
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

@NoPermission("test-only probe")
@Controller({ path: "whoami", version: "1" })
class WhoAmIController {
  @Get()
  get() {
    return { identity: currentRequestContext()?.identity ?? null };
  }
}

let pg18: BootstrappedPostgres;
let valkey: StartedValkey;
let issuer: TestIssuer;
let app: NestFastifyApplication;
let appDb: Database;
const roles: Record<string, string> = {};

const urlFor = (role: string, key: string) =>
  `postgres://${role}:${exampleValue(key)}@${pg18.container.getHost()}:${String(pg18.container.getMappedPort(5432))}/${appDatabase}`;

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

const grantKeys = async (
  orgId: string,
  role: string,
  keys: readonly string[],
) => {
  for (const permission of keys) {
    await asAdmin(
      `INSERT INTO bricx.role_permissions (id, org_id, role_id, permission, granted_at)
       VALUES ($1, $2, $3, $4, now() - interval '1 hour')`,
      [seedId(), orgId, role, permission],
    );
  }
};

type Res = Awaited<ReturnType<NestFastifyApplication["inject"]>>;
let keys = 0;
async function call(
  user: string,
  method: "GET" | "POST",
  url: string,
  body?: unknown,
  org = ORG_A,
): Promise<Res> {
  const headers: Record<string, string> = bearer(
    await issuer.token({
      sub: subOf(user),
      org_id: org,
      acr: "mfa",
      sid: `streams-${user}-${org}`,
      exp: Math.floor(Date.now() / 1000) + 3_600,
    }),
  );
  if (method === "POST") {
    keys += 1;
    headers[IDEMPOTENCY_KEY_HEADER] = `streams-key-${String(keys)}`;
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.inject({
    method,
    url,
    headers,
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}
const created = (res: Res) => {
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.body) as { id: string };
};

/** A membership row written as the test superuser, with any lifecycle columns. */
async function row(
  table: "memberships" | "project_memberships",
  values: Record<string, unknown>,
): Promise<string> {
  const id = seedId();
  const all = { id, created_at: "2026-01-01T00:00:00Z", ...values };
  const names = Object.keys(all);
  await asAdmin(
    `INSERT INTO bricx.${table} (${names.join(", ")}) VALUES (${names.map((_, i) => `$${String(i + 1)}`).join(", ")})`,
    Object.values(all),
  );
  return id;
}

beforeAll(async () => {
  [pg18, valkey, issuer] = await Promise.all([
    startPostgres(),
    startValkey(),
    TestIssuer.start(),
  ]);
  await migrate({
    reveal: () => urlFor("bricx_owner", "BRICX_OWNER_PASSWORD"),
  });
  await seedUsers(
    asAdmin,
    Object.values(users).map((id) => ({ id, sub: subOf(id) })),
  );
  await applyAccess(asAdmin, {
    orgId: ORG_A,
    userId: users.owner,
    role: "owner",
  });
  await applyAccess(asAdmin, {
    orgId: ORG_B,
    userId: users.ownerB,
    role: "owner",
  });
  await seedProjects(asAdmin, ORG_A, [P1, P2]);
  await seedProjects(asAdmin, ORG_B, [P_B]);
  for (const org of [ORG_A, ORG_B]) {
    const wide = await seedRole(asAdmin, org, "wide");
    await grantKeys(org, wide, WIDE_KEYS);
    roles[`wide:${org}`] = wide;
    roles[`member:${org}`] = await seedRole(asAdmin, org, "member");
    roles[`project_manager:${org}`] = await seedRole(
      asAdmin,
      org,
      "project_manager",
    );
    roles[`site_engineer:${org}`] = await seedRole(
      asAdmin,
      org,
      "site_engineer",
    );
  }
  const org = (user: string, role: string, extra = {}, orgId = ORG_A) =>
    row("memberships", {
      org_id: orgId,
      user_id: user,
      role_id: roles[`${role}:${orgId}`],
      ...extra,
    });
  const project = (
    user: string,
    projectId: string,
    role: string,
    extra = {},
    orgId = ORG_A,
  ) =>
    row("project_memberships", {
      org_id: orgId,
      project_id: projectId,
      user_id: user,
      role_id: roles[`${role}:${orgId}`],
      ...extra,
    });
  const past = "2026-06-01T00:00:00Z";
  const suspension = {
    suspended_at: past,
    suspended_by: users.owner,
    suspend_reason: "left",
  };
  // The active ones.
  await org(users.wide, "wide");
  await org(users.manager, "member");
  await project(users.manager, P1, "project_manager", {
    overrides: JSON.stringify({
      add: ["finance.budget.read.project"],
      remove: ["project.milestone.create.project"],
    }),
  });
  await project(users.manager, P2, "site_engineer");
  await org(users.engineer, "member");
  await org(users.external, "wide", { is_external: true });
  await project(users.external, P1, "project_manager");
  await org(users.elevated, "member");
  await project(users.elevated, P1, "site_engineer");
  // The ones that must be nowhere.
  await org(users.removed, "wide", { removed_at: past });
  await project(users.removed, P1, "project_manager", { removed_at: past });
  await org(users.suspended, "wide", suspension);
  await project(users.suspended, P1, "project_manager");
  await org(users.expired, "wide", { expires_at: past });
  await project(users.expired, P1, "project_manager");
  // Partly: the org row and P2 stay, P1 is suspended or expired.
  for (const [user, extra] of [
    [users.projectSuspended, suspension],
    [users.projectExpired, { expires_at: past }],
  ] as const) {
    await org(user, "wide");
    await project(user, P1, "project_manager", extra);
    await project(user, P2, "site_engineer");
  }
  // `both`: active in A, suspended in B (with a project row and an elevation there).
  await org(users.both, "wide");
  await project(users.both, P1, "site_engineer");
  await org(
    users.both,
    "wide",
    { ...suspension, suspended_by: users.ownerB },
    ORG_B,
  );
  await project(users.both, P_B, "project_manager", {}, ORG_B);
  // Elevations as the API writes them: an org and a project one for the
  // elevated member; one each for a suspended member (in A and in B) and
  // an org one for the external member (the API refuses it; SQL here).
  const elevation = (
    orgId: string,
    user: string,
    permission: string,
    scopeId: string | null,
    by: string,
  ) =>
    asAdmin(
      `INSERT INTO bricx.access_grants (id, org_id, user_id, permission, scope_id, reason, granted_by, starts_at, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, 'seed', $6, now() - interval '1 hour', now() + interval '1 hour', now() - interval '1 hour')`,
      [seedId(), orgId, user, permission, scopeId, by],
    );
  await elevation(
    ORG_A,
    users.elevated,
    "org.role.read.org",
    null,
    users.owner,
  );
  await elevation(
    ORG_A,
    users.elevated,
    "finance.budget.approve.project",
    P1,
    users.owner,
  );
  await elevation(
    ORG_A,
    users.suspended,
    "org.role.read.org",
    null,
    users.owner,
  );
  await elevation(
    ORG_B,
    users.both,
    "finance.budget.approve.project",
    P_B,
    users.ownerB,
  );
  await elevation(
    ORG_A,
    users.external,
    "org.role.read.org",
    null,
    users.owner,
  );

  const appUrl = urlFor("bricx_app", "BRICX_APP_PASSWORD");
  appDb = openDatabase({ reveal: () => appUrl });
  app = await createApp(
    loadApiConfig(
      apiEnv({
        ...issuer.env(),
        DATABASE_URL: appUrl,
        VALKEY_URL: valkey.url(),
      }),
    ),
    {
      probes: fakeProbes(),
      revocationStore: fixedRevocations(),
      rateLimitStore: memoryRateLimits(),
      extraControllers: [WhoAmIController],
      logStream: new Writable({
        write(_chunk: Buffer, _encoding, done) {
          done();
        },
      }),
    },
  );
  await app.init();
  // The engineer: site_engineer on P1 with one assigned site of two (through the API).
  const [s1] = await Promise.all(
    ["One", "Two"].map(async (name) =>
      created(
        await call(users.owner, "POST", `/v1/projects/${P1}/sites`, {
          name: `Site ${name}`,
          boundary: SQUARE,
        }),
      ),
    ),
  );
  created(
    await call(users.owner, "POST", `/v1/projects/${P1}/members`, {
      userId: users.engineer,
      roleId: roles[`site_engineer:${ORG_A}`],
      siteIds: [s1?.id],
    }),
  );
}, HOOK_MS);
afterAll(async () => {
  await app.close().catch(() => undefined);
  await appDb.close().catch(() => undefined);
  await issuer.close();
  await valkey.stop();
  await pg18.container.stop();
}, HOOK_MS);

interface Identity {
  projectIds: string[];
  allProjects: boolean;
  grants: {
    permission: string;
    scope: string;
    projectIds?: string[];
    siteIds?: string[];
  }[];
}
/** What the request path computes for the user, as (permission, scope, target) rows. */
async function requestRows(user: string, org = ORG_A) {
  const res = await call(user, "GET", "/v1/whoami", undefined, org);
  expect(res.statusCode, res.body).toBe(200);
  const { identity } = JSON.parse(res.body) as { identity: Identity };
  const rows = identity.grants.flatMap((g) => {
    if (g.scope === "project") {
      return (g.projectIds ?? []).map((id) => `${g.permission}|project|${id}`);
    }
    if (g.scope === "site") {
      return (g.siteIds ?? []).map((id) => `${g.permission}|site|${id}`);
    }
    return [`${g.permission}|${g.scope}|`];
  });
  return { identity, rows: [...new Set(rows)].sort() };
}
/** The grants view's rows for the user in the org (as the superuser), '*' expanded as the owner bundle. */
async function viewRows(user: string, org = ORG_A) {
  const found = await asAdmin<{
    permission: string;
    scope: string;
    target: string | null;
  }>(
    `SELECT permission, scope, target_id::text AS target FROM ${STREAM_SOURCES.userGrants} WHERE org_id = $1 AND user_id = $2`,
    [org, user],
  );
  const rows = found.flatMap((r) => {
    if (r.permission !== "*") {
      return [`${r.permission}|${r.scope}|${r.target ?? ""}`];
    }
    // The system owner role: its bundle lives in code (ROLES.owner).
    return ROLES.owner.flatMap((key) => {
      const parsed = parseCatalogueKey(key);
      if (parsed === undefined) return [];
      return parsed.scope === "org" || parsed.scope === "own"
        ? [`${parsed.permission}|${parsed.scope}|`]
        : [];
    });
  });
  return [...new Set(rows)].sort();
}
const projectsInView = (user: string, org?: string) =>
  asAdmin<{ org_id: string; project_id: string }>(
    `SELECT org_id::text, project_id::text FROM ${STREAM_SOURCES.userProjectAccess}
     WHERE user_id = $1 AND ($2::uuid IS NULL OR org_id = $2) ORDER BY 1, 2`,
    [user, org ?? null],
  );
const grantsInView = (user: string, org?: string) =>
  asAdmin<{ org_id: string }>(
    `SELECT org_id::text FROM ${STREAM_SOURCES.userGrants}
     WHERE user_id = $1 AND ($2::uuid IS NULL OR org_id = $2)`,
    [user, org ?? null],
  );

describe("agreement: the stream sources are what the request path computes (DW8)", () => {
  test("the two sources are the views the generated sync-streams.yaml names", () => {
    expect(STREAM_SOURCES).toEqual({
      userProjectAccess: "app.user_project_access",
      userGrants: "app.user_grants_source",
    });
  });

  test.each([
    ["a custom org role (org and own keys)", "wide"],
    ["project roles with overrides on two projects", "manager"],
    ["a site role with one assigned site of two", "engineer"],
    [
      "an external member (allowlisted org keys only, no own key, no org elevation)",
      "external",
    ],
    ["an org and a project elevation", "elevated"],
    [
      "a project-level suspension (the other project stays)",
      "projectSuspended",
    ],
    [
      "an expired project membership (the other project stays)",
      "projectExpired",
    ],
    ["a member of two orgs, read in the one where they are active", "both"],
  ] as const)("%s: the same rows", async (_name, who) => {
    const user = users[who];
    const request = await requestRows(user);
    expect(request.rows.length).toBeGreaterThan(0);
    expect(await viewRows(user)).toEqual(request.rows);
    // The project ids too (when the request path names them one by one).
    if (!request.identity.allProjects) {
      expect(
        (await projectsInView(user, ORG_A)).map((r) => r.project_id).sort(),
      ).toEqual([...request.identity.projectIds].sort());
    }
  });

  test("what those rows are, for the cases that matter: the external member holds one org key and no finance key at org scope; the suspended project is in neither source and the other is in both", async () => {
    const external = await viewRows(users.external);
    expect(external.filter((r) => r.endsWith("|org|"))).toEqual([
      "org.region_config.read|org|",
    ]);
    // The org role's own-scope key is the wide member's, not the external member's.
    expect(await viewRows(users.wide)).toContain("project.task.read|own|");
    expect(external).not.toContain("project.task.read|own|");
    expect(
      (await requestRows(users.external)).rows.filter((r) =>
        r.endsWith("|org|"),
      ),
    ).toEqual(["org.region_config.read|org|"]);
    for (const user of [users.projectSuspended, users.projectExpired]) {
      expect((await projectsInView(user)).map((r) => r.project_id)).toEqual([
        P2,
      ]);
      const rows = await viewRows(user);
      expect(rows.filter((r) => r.endsWith(`|${P1}`))).toEqual([]);
      expect(rows.filter((r) => r.endsWith(`|${P2}`)).length).toBeGreaterThan(
        0,
      );
    }
    // The elevated member: both elevations are rows.
    const elevated = await viewRows(users.elevated);
    expect(elevated).toContain("org.role.read|org|");
    expect(elevated).toContain(`finance.budget.approve|project|${P1}`);
  });

  test("the system owner role is one '*' row at org scope, which is the whole catalogue on the request path", async () => {
    const found = await asAdmin<{ permission: string; scope: string }>(
      `SELECT permission, scope FROM ${STREAM_SOURCES.userGrants} WHERE org_id = $1 AND user_id = $2`,
      [ORG_A, users.owner],
    );
    expect(found).toEqual([{ permission: "*", scope: "org" }]);
    const request = await requestRows(users.owner);
    expect(request.identity.allProjects).toBe(true);
    const orgAndOwn = request.rows.filter(
      (r) => r.endsWith("|org|") || r.endsWith("|own|"),
    );
    expect(await viewRows(users.owner)).toEqual(orgAndOwn);
  });
});

describe("leak: a removed, suspended or expired member is in no stream source (C1, rule 3)", () => {
  test.each([
    ["removed", "removed"],
    [
      "suspended (with an open project row and a running elevation)",
      "suspended",
    ],
    ["expired (with an open project row)", "expired"],
  ] as const)(
    "%s in org A: no row in either source, in any org; the request path refuses them (403)",
    async (_name, who) => {
      const user = users[who];
      expect(await projectsInView(user)).toEqual([]);
      expect(await grantsInView(user)).toEqual([]);
      expect(
        await asAdmin(
          "SELECT 1 FROM app.active_memberships WHERE user_id = $1 UNION ALL SELECT 1 FROM app.active_project_memberships WHERE user_id = $1",
          [user],
        ),
      ).toEqual([]);
      expect((await call(user, "GET", "/v1/whoami")).statusCode).toBe(403);
    },
  );

  test("two orgs at once: suspended in B and active in A, the user has rows for A only (no project, no elevation of B), and B's request path refuses them", async () => {
    expect((await projectsInView(users.both)).map((r) => r.org_id)).toEqual([
      ORG_A,
    ]);
    expect([
      ...new Set((await grantsInView(users.both)).map((r) => r.org_id)),
    ]).toEqual([ORG_A]);
    expect(await projectsInView(users.both, ORG_B)).toEqual([]);
    expect(await grantsInView(users.both, ORG_B)).toEqual([]);
    expect(
      (await call(users.both, "GET", "/v1/whoami", undefined, ORG_B))
        .statusCode,
    ).toBe(403);
    // The rows the views left out do exist (the test is not vacuous).
    const [stored] = await asAdmin<{ n: number }>(
      `SELECT (SELECT count(*) FROM bricx.project_memberships WHERE org_id = $1 AND user_id = $2 AND removed_at IS NULL)::int
            + (SELECT count(*) FROM bricx.access_grants WHERE org_id = $1 AND user_id = $2 AND revoked_at IS NULL)::int AS n`,
      [ORG_B, users.both],
    );
    expect(stored?.n).toBe(2);
  });

  test("read as bricx_app under RLS (security_invoker): org A's owner sees org A's active rows only; no suspended, expired or removed user and no row of org B; org B's owner sees no row of org A", async () => {
    const gone = [users.removed, users.suspended, users.expired];
    const read = (orgId: string, userId: string) =>
      appDb.withTx(
        { orgId, userId, projectIds: [], allProjects: true },
        async (tx) => {
          const projects = await tx.execute(
            sql`SELECT org_id::text, user_id::text, project_id::text FROM app.user_project_access`,
          );
          const grants = await tx.execute(
            sql`SELECT org_id::text, user_id::text FROM app.user_grants_source`,
          );
          return [...projects.rows, ...grants.rows] as {
            org_id: string;
            user_id: string;
            project_id?: string;
          }[];
        },
      );
    const inA = await read(ORG_A, users.owner);
    expect(inA.length).toBeGreaterThan(10);
    expect([...new Set(inA.map((r) => r.org_id))]).toEqual([ORG_A]);
    expect(inA.filter((r) => gone.includes(r.user_id as never))).toEqual([]);
    expect(
      inA.filter(
        (r) =>
          r.project_id === P1 &&
          (r.user_id === users.projectSuspended ||
            r.user_id === users.projectExpired),
      ),
    ).toEqual([]);
    const inB = await read(ORG_B, users.ownerB);
    expect([...new Set(inB.map((r) => r.org_id))]).toEqual([ORG_B]);
    expect(inB.map((r) => r.user_id)).not.toContain(users.both);
    expect([...new Set(inB.map((r) => r.user_id))]).toEqual([users.ownerB]);
  });

  test("the moment a member is suspended through the API they leave both sources, and return on reactivation", async () => {
    const [membership] = await asAdmin<{ id: string }>(
      "SELECT id::text FROM bricx.memberships WHERE org_id = $1 AND user_id = $2",
      [ORG_A, users.wide],
    );
    expect((await grantsInView(users.wide)).length).toBeGreaterThan(0);
    const suspended = await call(
      users.owner,
      "POST",
      `/v1/members/${membership?.id ?? ""}/suspend`,
      { reason: "leak test" },
    );
    expect(suspended.statusCode, suspended.body).toBe(200);
    expect(await grantsInView(users.wide)).toEqual([]);
    expect(await projectsInView(users.wide)).toEqual([]);
    const back = await call(
      users.owner,
      "POST",
      `/v1/members/${membership?.id ?? ""}/reactivate`,
    );
    expect(back.statusCode, back.body).toBe(200);
    expect((await grantsInView(users.wide)).length).toBe(WIDE_KEYS.length);
  });
});
