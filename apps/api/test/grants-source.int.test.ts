// P5-05 (ADR 0066; phase ruling D7, owner condition 2): the production
// grants source, DbGrantsSource, against compose.yml's Postgres with the
// production journal, through the real app (no test-only source). It
// reads, in one withTx() as the chosen org and the user, the user's open
// org membership (its role's open role_permissions: org and own keys as
// they are, project and site keys dropped), the user's open project
// memberships in that org (effectiveKeys of the role's bundle and the
// row's overrides: project keys become grants on that project, own keys
// as they are, org and site keys dropped; site until P6-05), with the
// virtual owner bundle from code. allProjects (app.project_ids = '*') is
// set when an org-scoped grant names a project- or site-level resource,
// never for a project-scope-only identity. A user without an open
// membership in the chosen org is 403 membership_missing and gets no
// sessions row; the claim preselects the org and X-Org-Id switches it.
import { Writable } from "node:stream";
import { loadApiConfig } from "@bricx/config/api";
import {
  type BootstrappedPostgres,
  appDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { migrate } from "@bricx/db/migrate";
import { CATALOGUE, parseCatalogueKey } from "@bricx/permissions/catalogue";
import { effectiveKeys } from "@bricx/permissions/overrides";
import { ROLES } from "@bricx/permissions/roles";
import { Controller, Get, Inject } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { ORG_ID_HEADER } from "../src/common/auth/auth.guard.js";
import {
  type Access,
  MAX_PROJECT_MEMBERSHIPS,
} from "../src/common/auth/grants-source.js";
import { currentRequestContext } from "../src/common/db/request-context.js";
import { TxRunner } from "../src/common/db/tx-runner.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";
import {
  fixedRevocations,
  TestIssuer,
  applyAccess,
  bearer,
  seedId,
  seedRole,
  seedUsers,
} from "./support/auth.js";

const HOOK_MS = 300_000;
const ORG_A = "0199e1a0-0000-7000-8000-0000000000a1";
const ORG_B = "0199e1a0-0000-7000-8000-0000000000b1";
const PROJECT_1 = "0199e1a0-0000-7000-8000-0000000000a3";
const PROJECT_2 = "0199e1a0-0000-7000-8000-0000000000a4";
const ELSEWHERE_PROJECT = "0199e1a0-0000-7000-8000-0000000000b3";
const users = {
  owner: "0199e1a0-0000-7000-8000-0000000000e1",
  reviewer: "0199e1a0-0000-7000-8000-0000000000e2",
  manager: "0199e1a0-0000-7000-8000-0000000000e3",
  accountant: "0199e1a0-0000-7000-8000-0000000000e4",
  nobody: "0199e1a0-0000-7000-8000-0000000000e5",
  elsewhere: "0199e1a0-0000-7000-8000-0000000000e6",
  removed: "0199e1a0-0000-7000-8000-0000000000e7",
  archived: "0199e1a0-0000-7000-8000-0000000000e8",
  many: "0199e1a0-0000-7000-8000-0000000000e9",
  both: "0199e1a0-0000-7000-8000-0000000000ea",
} as const;
const subOf = (user: string) => `grants-${user}`;

@Controller({ path: "whoami", version: "1" })
class WhoAmIController {
  constructor(@Inject(TxRunner) private readonly runner: TxRunner) {}

  @Get()
  get() {
    return { identity: currentRequestContext()?.identity ?? null };
  }

  /** What the transaction sees: app.project_ids and has_project(). */
  @Get("projects")
  projects() {
    return this.runner.run(async (tx) => {
      const { rows } = await tx.execute(
        sql`SELECT current_setting('app.project_ids', true) AS ids,
                   app.has_project(${PROJECT_1}::uuid) AS p1,
                   app.has_project(${ELSEWHERE_PROJECT}::uuid) AS other`,
      );
      return rows[0];
    });
  }
}

let pg18: BootstrappedPostgres;
let issuer: TestIssuer;
let app: NestFastifyApplication;
const lines: string[] = [];

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

/** The reviewer's custom role: one org key, one project key (dropped at org level), one unknown, one revoked. */
const REVIEWER_KEYS = {
  org: "org.member.read.org",
  project: "project.milestone.read.project",
  unknown: "nope.nope.nope.org",
  revoked: "org.role.read.org",
} as const;

/** A project-scope key the project_manager bundle lacks (an override add). */
const EXTRA_PROJECT_KEY = CATALOGUE.find(
  (k) => k.endsWith(".project") && !ROLES.project_manager.includes(k),
);
if (EXTRA_PROJECT_KEY === undefined) throw new Error("no extra project key");
const MANAGER_OVERRIDES = {
  add: [EXTRA_PROJECT_KEY],
  remove: ["project.milestone.create.project"],
};

beforeAll(async () => {
  [pg18, issuer] = await Promise.all([startPostgres(), TestIssuer.start()]);
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
    orgId: ORG_A,
    userId: users.accountant,
    role: "accountant",
  });
  // The reviewer: a custom role with hand-written keys.
  const reviewer = await seedRole(asAdmin, ORG_A, "reviewer");
  for (const [permission, revoked] of [
    [REVIEWER_KEYS.org, null],
    [REVIEWER_KEYS.project, null],
    [REVIEWER_KEYS.unknown, null],
    [REVIEWER_KEYS.revoked, "now() - interval '1 minute'"],
  ] as const) {
    await asAdmin(
      `INSERT INTO bricx.role_permissions (id, org_id, role_id, permission, granted_at, revoked_at)
       VALUES ($1, $2, $3, $4, now() - interval '1 hour', ${revoked ?? "NULL"})`,
      [seedId(), ORG_A, reviewer, permission],
    );
  }
  await applyAccess(asAdmin, {
    orgId: ORG_A,
    userId: users.reviewer,
    role: "reviewer",
  });
  // The manager: an empty org role, project_manager on project 1 with
  // overrides, quantity_surveyor on project 2, a removed row on another.
  await applyAccess(asAdmin, {
    orgId: ORG_A,
    userId: users.manager,
    role: "member",
  });
  await asAdmin(
    `INSERT INTO bricx.project_memberships (id, org_id, project_id, user_id, role_id, overrides, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, now() - interval '1 minute')`,
    [
      seedId(),
      ORG_A,
      PROJECT_1,
      users.manager,
      await seedRole(asAdmin, ORG_A, "project_manager"),
      JSON.stringify(MANAGER_OVERRIDES),
    ],
  );
  await asAdmin(
    `INSERT INTO bricx.project_memberships (id, org_id, project_id, user_id, role_id, created_at)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute')`,
    [
      seedId(),
      ORG_A,
      PROJECT_2,
      users.manager,
      await seedRole(asAdmin, ORG_A, "quantity_surveyor"),
    ],
  );
  await asAdmin(
    `INSERT INTO bricx.project_memberships (id, org_id, project_id, user_id, role_id, created_at, removed_at)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', now() - interval '1 minute')`,
    [
      seedId(),
      ORG_A,
      ELSEWHERE_PROJECT,
      users.manager,
      await seedRole(asAdmin, ORG_A, "project_manager"),
    ],
  );
  // Elsewhere: an owner of org B only.
  await applyAccess(asAdmin, {
    orgId: ORG_B,
    userId: users.elsewhere,
    role: "owner",
  });
  // Removed: the org membership closed, a project membership still open.
  await applyAccess(asAdmin, {
    orgId: ORG_A,
    userId: users.removed,
    role: "project_manager",
    projects: [PROJECT_1],
  });
  await asAdmin(
    "UPDATE bricx.memberships SET removed_at = now() WHERE user_id = $1",
    [users.removed],
  );
  // Archived: a member whose role was archived.
  await applyAccess(asAdmin, {
    orgId: ORG_A,
    userId: users.archived,
    role: "auditor",
  });
  await asAdmin(
    "UPDATE bricx.roles SET archived_at = now() WHERE org_id = $1 AND key = 'auditor'",
    [ORG_A],
  );
  // Many: one more project membership than the cap, oldest first.
  await applyAccess(asAdmin, {
    orgId: ORG_A,
    userId: users.many,
    role: "member",
  });
  await asAdmin(
    `INSERT INTO bricx.project_memberships (id, org_id, project_id, user_id, role_id, created_at)
     SELECT ('0199e1a5-0000-7000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, $1, ('0199e1a6-0000-7000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, $2, $3, now() - interval '1 day' + make_interval(secs => n)
     FROM generate_series(1, $4::int) AS n`,
    [
      ORG_A,
      users.many,
      await seedRole(asAdmin, ORG_A, "client"),
      MAX_PROJECT_MEMBERSHIPS + 1,
    ],
  );
  // Both: an auditor in org A, an accountant in org B.
  await applyAccess(asAdmin, {
    orgId: ORG_A,
    userId: users.both,
    role: "owner",
  });
  await applyAccess(asAdmin, {
    orgId: ORG_B,
    userId: users.both,
    role: "accountant",
  });

  app = await createApp(
    loadApiConfig(
      apiEnv({
        ...issuer.env(),
        DATABASE_URL: urlFor("bricx_app", "BRICX_APP_PASSWORD"),
      }),
    ),
    {
      probes: fakeProbes(),
      revocationStore: fixedRevocations(),
      logStream: new Writable({
        write(chunk: Buffer, _encoding, done) {
          lines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
          done();
        },
      }),
      extraControllers: [WhoAmIController],
    },
  );
  await app.init();
}, HOOK_MS);
afterAll(async () => {
  await app.close().catch(() => undefined);
  await issuer.close();
  await pg18.container.stop();
}, HOOK_MS);

const logged = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

async function call(
  user: string,
  claimOrg: string,
  headers: Record<string, string> = {},
  url = "/v1/whoami",
) {
  const token = await issuer.token({ sub: subOf(user), org_id: claimOrg });
  return app.inject({
    method: "GET",
    url,
    headers: { ...bearer(token), ...headers },
  });
}

async function identityOf(
  user: string,
  claimOrg = ORG_A,
  headers: Record<string, string> = {},
): Promise<Access & { orgId: string; userId: string }> {
  const res = await call(user, claimOrg, headers);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ identity: Access & { orgId: string; userId: string } }>()
    .identity;
}

const sessionsOf = (user: string) =>
  asAdmin<{ org_id: string }>(
    "SELECT org_id::text FROM bricx.sessions WHERE user_id = $1 ORDER BY org_id",
    [user],
  );

/** The org grants of a bundle: every key at org scope, sorted. */
const orgGrants = (keys: readonly string[]) =>
  [...keys]
    .filter((k) => k.endsWith(".org"))
    .sort()
    .map((k) => ({ permission: k.slice(0, -4), scope: "org" }));

const sortGrants = (grants: readonly unknown[]) =>
  [...grants].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));

describe("no membership in the chosen org (D7)", () => {
  test("403 forbidden, reason membership_missing; the user is provisioned but no sessions row is written", async () => {
    lines.length = 0;
    const res = await call(users.nobody, ORG_A);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "forbidden" });
    expect(
      logged()
        .filter((l) => l.msg === "auth.failed")
        .map((l) => l.reason),
    ).toEqual(["membership_missing"]);
    expect(await sessionsOf(users.nobody)).toEqual([]);
    expect(
      await asAdmin("SELECT 1 FROM bricx.users WHERE id = $1", [users.nobody]),
    ).toHaveLength(1);
  });

  test("a removed org membership: 403, even with an open project membership (s17 guard)", async () => {
    expect((await call(users.removed, ORG_A)).statusCode).toBe(403);
    expect(await sessionsOf(users.removed)).toEqual([]);
  });

  test("a member of another org: refused where the claim points, accepted where X-Org-Id points; the session is in that org", async () => {
    expect((await call(users.elsewhere, ORG_A)).statusCode).toBe(403);
    const identity = await identityOf(users.elsewhere, ORG_A, {
      [ORG_ID_HEADER]: ORG_B,
    });
    expect(identity.orgId).toBe(ORG_B);
    expect(identity.allProjects).toBe(true);
    expect(await sessionsOf(users.elsewhere)).toEqual([{ org_id: ORG_B }]);
    expect((await identityOf(users.elsewhere, ORG_B)).orgId).toBe(ORG_B);
  });
});

describe("what a membership grants", () => {
  test("the owner: the virtual bundle from code, every key at org scope, allProjects and no project ids", async () => {
    const identity = await identityOf(users.owner);
    expect(sortGrants(identity.grants)).toEqual(
      sortGrants(orgGrants(ROLES.owner)),
    );
    expect(identity.projectIds).toEqual([]);
    expect(identity.allProjects).toBe(true);
    expect(identity).not.toHaveProperty("unknownKeys");
  });

  test("an org role with project-level org keys (accountant) is allProjects too", async () => {
    const identity = await identityOf(users.accountant);
    expect(sortGrants(identity.grants)).toEqual(
      sortGrants(orgGrants(ROLES.accountant)),
    );
    expect(identity.allProjects).toBe(true);
  });

  test("a custom org role: open org keys only; a project key is dropped, a revoked one ignored, an unknown one counted and logged once (ids only)", async () => {
    lines.length = 0;
    const identity = await identityOf(users.reviewer);
    expect(identity.grants).toEqual([
      { permission: "org.member.read", scope: "org" },
    ]);
    expect(identity.allProjects).toBe(false);
    expect(identity.projectIds).toEqual([]);
    const warned = logged().filter(
      (l) => l.msg === "grants.unknown_permission",
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({
      userId: users.reviewer,
      orgId: ORG_A,
      count: 1,
      level: 40,
    });
    expect(lines.join("\n")).not.toContain(REVIEWER_KEYS.unknown);
  });

  test("project memberships: effective keys at project scope on that project, merged per permission across projects; own keys kept, org and site keys dropped; removed rows ignored; never allProjects", async () => {
    const identity = await identityOf(users.manager);
    expect(identity.allProjects).toBe(false);
    expect(identity.projectIds).toEqual([PROJECT_1, PROJECT_2]);
    const expected = new Map<string, Set<string>>();
    const own = new Set<string>();
    const add = (keys: readonly string[], project: string) => {
      for (const key of keys) {
        const parsed = parseCatalogueKey(key);
        if (parsed === undefined) throw new Error(key);
        if (parsed.scope === "project") {
          expected.set(
            parsed.permission,
            new Set([...(expected.get(parsed.permission) ?? []), project]),
          );
        } else if (parsed.scope === "own") {
          own.add(parsed.permission);
        }
      }
    };
    add(effectiveKeys(ROLES.project_manager, MANAGER_OVERRIDES), PROJECT_1);
    add(ROLES.quantity_surveyor, PROJECT_2);
    const want = [
      ...[...expected].map(([permission, projects]) => ({
        permission,
        scope: "project",
        projectIds: [...projects].sort(),
      })),
      ...[...own].map((permission) => ({ permission, scope: "own" })),
    ];
    expect(sortGrants(identity.grants)).toEqual(sortGrants(want));
    expect(identity.grants.some((g) => g.scope === "org")).toBe(false);
    expect(identity.grants.some((g) => g.scope === "site")).toBe(false);
    const extra = parseCatalogueKey(EXTRA_PROJECT_KEY);
    expect(
      identity.grants.find((g) => g.permission === extra?.permission),
    ).toEqual({
      permission: extra?.permission,
      scope: "project",
      projectIds: [PROJECT_1],
    });
    expect(
      identity.grants.find((g) => g.permission === "project.milestone.create"),
    ).toBeUndefined();
  });

  test("an archived role grants nothing, the membership stands (for architect review)", async () => {
    const identity = await identityOf(users.archived);
    expect(identity.grants).toEqual([]);
    expect(identity.allProjects).toBe(false);
  });

  test("at most MAX_PROJECT_MEMBERSHIPS project rows are read, newest first", async () => {
    const identity = await identityOf(users.many);
    expect(identity.projectIds).toHaveLength(MAX_PROJECT_MEMBERSHIPS);
    // Row 1 is the oldest and the one left out.
    expect(identity.projectIds).not.toContain(
      "0199e1a6-0000-7000-8000-000000000001",
    );
    expect(identity.projectIds).toContain(
      `0199e1a6-0000-7000-8000-${(MAX_PROJECT_MEMBERSHIPS + 1).toString(16).padStart(12, "0")}`,
    );
  });

  test("the read is scoped to the chosen org: the same user holds different roles in A and B", async () => {
    const inA = await identityOf(users.both, ORG_A);
    const inB = await identityOf(users.both, ORG_A, { [ORG_ID_HEADER]: ORG_B });
    expect(sortGrants(inA.grants)).toEqual(sortGrants(orgGrants(ROLES.owner)));
    expect(sortGrants(inB.grants)).toEqual(
      sortGrants(orgGrants(ROLES.accountant)),
    );
    expect((await sessionsOf(users.both)).map((s) => s.org_id)).toEqual([
      ORG_A,
      ORG_B,
    ]);
  });
});

describe("the wildcard in the transaction (owner condition 2)", () => {
  test("an owner's transaction runs with app.project_ids = '*' and has_project() true for any project", async () => {
    const res = await call(users.owner, ORG_A, {}, "/v1/whoami/projects");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ids: "*", p1: true, other: true });
  });

  test("a project-scope-only identity runs with its project ids and never '*'", async () => {
    const res = await call(users.manager, ORG_A, {}, "/v1/whoami/projects");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      ids: `{${PROJECT_1},${PROJECT_2}}`,
      p1: true,
      other: false,
    });
  });

  test("a member with nothing runs with no project ids", async () => {
    const res = await call(users.reviewer, ORG_A, {}, "/v1/whoami/projects");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ids: "{}", p1: false, other: false });
  });
});
