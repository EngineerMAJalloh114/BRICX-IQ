// P5-07 (ADR 0068; Done when DW2 and DW3; owner conditions 1, 3, 4 and 5,
// decisions D-E, D-F as changed, D-I): the authorization guard, after the
// AuthGuard, with real RS256 tokens and no database.
// - @Can(permission, { projectParam, siteParam }) declares a route's
//   catalogue permission; an unknown one fails when the class is declared
//   (boot), and so does a scope parameter the resource cannot have;
// - every route carries @Can, @NoPermission(reason) (self-service, checked
//   in the service) or @Public(): an unmarked route makes createApp fail,
//   and the app's route list is pinned here (fail closed);
// - the scope comes from the route parameters; without one the guard asks
//   whether the identity holds the action anywhere in the org and the
//   service checks the record;
// - the ability is abilityFor(identity) over the grants the grants source
//   gave (elevations included), memoised for the sealed identity;
// - a finance key (requiresMfa / MFA_KEY_PREFIX) needs acr mfa: otherwise
//   401 permission.step_up_required with WWW-Authenticate: Bearer
//   error="insufficient_user_authentication", acr_values="mfa" (RFC 9470),
//   never 403 and never session_expired;
// - acr is "mfa" only when the verified token says exactly "mfa"; missing
//   or anything else is "pwd"; no header changes it.
import { Writable } from "node:stream";
import { loadApiConfig } from "@bricx/config/api";
import { isProjectId } from "@bricx/ids/branded";
import type { Grant } from "@bricx/permissions/ability";
import { PERMISSIONS } from "@bricx/permissions/catalogue";
import { SOD_VIOLATION_KEY } from "@bricx/permissions/errors";
import { MFA_KEY_PREFIX } from "@bricx/permissions/mfa";
import { ERROR_KEYS, ERROR_STATUS } from "@bricx/validation/codes";
import { ErrorEnvelopeSchema } from "@bricx/validation/error-envelope";
import { Controller, Get } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { type CreateAppOptions, createApp } from "../src/app.js";
import {
  CanDeclarationError,
  NoPermission,
  canRule,
} from "../src/common/auth/can.decorator.js";
import {
  controllerMarkers,
  routeMarkers,
} from "../src/common/auth/route-markers.js";
import { STEP_UP_CHALLENGE } from "../src/common/errors/problem.filter.js";
import { TemplateItemsController } from "../src/modules/_template/template-items.controller.js";
import type { Access } from "../src/common/auth/grants-source.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";
import {
  TestIssuer,
  bearer,
  fixedAccess,
  fixedRevocations,
  fixedSessions,
  fixedUsers,
} from "./support/auth.js";
import {
  FINANCE_FIXTURE_PATH,
  FinanceFixtureController,
} from "./support/finance-fixture.js";

const ORG = "0199e1a0-0000-7000-8000-00000000070a";
const USER = "0199e1a0-0000-7000-8000-000000000701";
const PROJECT = "0199e1a0-0000-7000-8000-000000000710";
const OTHER_PROJECT = "0199e1a0-0000-7000-8000-000000000711";
const PAYMENT = "0199e1a0-0000-7000-8000-000000000720";
const SUB = "sub-p5-07-guard";

const APPROVE = `/v1/${FINANCE_FIXTURE_PATH}/projects/${PROJECT}/payments/${PAYMENT}/approve`;
const REQUEST = `/v1/${FINANCE_FIXTURE_PATH}/projects/${PROJECT}/payments`;
const milestonesOf = (project: string) =>
  `/v1/${FINANCE_FIXTURE_PATH}/projects/${project}/milestones`;
const ANYWHERE = `/v1/${FINANCE_FIXTURE_PATH}/milestones`;
const ROLES = `/v1/${FINANCE_FIXTURE_PATH}/roles`;

const projectGrant = (
  permission: Grant["permission"],
  projectIds: readonly string[] = [PROJECT],
): Grant => ({
  permission,
  scope: "project",
  projectIds: projectIds.filter(isProjectId),
});
const orgGrant = (permission: Grant["permission"]): Grant => ({
  permission,
  scope: "org",
});

/** Access whose grants are `grants`, of which `membership` came from memberships. */
const accessOf = (
  grants: readonly Grant[],
  membership: readonly Grant[] = grants,
): Access => ({
  projectIds: [PROJECT],
  allProjects: false,
  grants: [...grants],
  membershipGrants: [...membership],
});

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

interface Started {
  app: NestFastifyApplication;
  logged: () => Record<string, unknown>[];
}

async function start(
  access: Access | undefined,
  options: Partial<CreateAppOptions> & {
    config?: Record<string, string>;
  } = {},
): Promise<Started> {
  const { config = {}, ...appOptions } = options;
  const lines: string[] = [];
  const logStream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
      done();
    },
  });
  app = await createApp(loadApiConfig(apiEnv({ ...issuer.env(), ...config })), {
    probes: fakeProbes(),
    logStream,
    extraControllers: [FinanceFixtureController],
    userDirectory: fixedUsers({ [SUB]: USER }, USER),
    sessionTracker: fixedSessions(),
    revocationStore: fixedRevocations(),
    grantsSource: fixedAccess(access),
    ...appOptions,
  });
  await app.init();
  return {
    app,
    logged: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

const token = (claims: Record<string, unknown> = {}) =>
  issuer.token({ sub: SUB, org_id: ORG, ...claims });

const call = async (
  s: Started,
  method: "GET" | "POST",
  url: string,
  claims: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) =>
  s.app.inject({
    method,
    url,
    headers: { ...bearer(await token(claims)), ...headers },
  });

/** The body without its traceId, which differs per request. */
function bodyWithoutTrace(body: string): unknown {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  delete parsed.traceId;
  return parsed;
}

function expectStepUp(res: {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
}) {
  expect(res.statusCode).toBe(401);
  expect(res.statusCode).not.toBe(403);
  expect(res.headers["www-authenticate"]).toBe(
    'Bearer error="insufficient_user_authentication", acr_values="mfa"',
  );
  expect(ErrorEnvelopeSchema.safeParse(JSON.parse(res.body)).success).toBe(
    true,
  );
  expect(bodyWithoutTrace(res.body)).toEqual({
    status: 401,
    code: "permission.step_up_required",
    key: "errors:permission.step_up_required",
  });
}

function expectForbidden(res: { statusCode: number; body: string }) {
  expect(res.statusCode).toBe(403);
  expect(bodyWithoutTrace(res.body)).toEqual({
    status: 403,
    code: "forbidden",
    key: "errors:forbidden",
  });
}

describe("@Can declarations are checked when the class is declared (boot)", () => {
  test("a catalogue permission is accepted; its resource level is kept", () => {
    expect(
      canRule("finance.payment.approve", { projectParam: "projectId" }),
    ).toEqual({
      permission: "finance.payment.approve",
      level: "project",
      projectParam: "projectId",
    });
    expect(canRule("org.role.read", {})).toEqual({
      permission: "org.role.read",
      level: "org",
    });
  });

  test.each([
    ["an unknown action", "finance.payment.steal", {}],
    ["an unknown resource", "finance.vault.read", {}],
    [
      "a catalogue key with its scope (not a permission)",
      "org.role.read.org",
      {},
    ],
    ["not a string", 42, {}],
    [
      "a project parameter on an org resource",
      "org.role.read",
      { projectParam: "projectId" },
    ],
    [
      "a site parameter on a project resource",
      "finance.payment.approve",
      { projectParam: "projectId", siteParam: "siteId" },
    ],
    [
      "a site parameter without a project parameter",
      "field.dailylog.approve",
      { siteParam: "siteId" },
    ],
    [
      "a parameter name that is not an identifier",
      "finance.payment.approve",
      { projectParam: "project-id" },
    ],
  ])("%s is refused", (_name, permission, options) => {
    expect(() => canRule(permission, options)).toThrow(CanDeclarationError);
  });

  test("@NoPermission needs a reason (1-200 characters)", () => {
    expect(() => NoPermission("")).toThrow(CanDeclarationError);
    expect(() => NoPermission("x".repeat(201))).toThrow(CanDeclarationError);
    expect(() => NoPermission("the caller's own rows")).not.toThrow();
  });
});

describe("every route is marked (D-E, condition 5: fail closed)", () => {
  test("createApp refuses an app with a route that has no @Can, @NoPermission or @Public", async () => {
    @Controller({ path: "unmarked", version: "1" })
    class UnmarkedController {
      @Get()
      get() {
        return {};
      }
    }
    await expect(
      createApp(loadApiConfig(apiEnv(issuer.env())), {
        probes: fakeProbes(),
        logStream: new Writable({
          write: (_c, _e, done) => {
            done();
          },
        }),
        extraControllers: [UnmarkedController],
        userDirectory: fixedUsers({}, USER),
        sessionTracker: fixedSessions(),
        revocationStore: fixedRevocations(),
        grantsSource: fixedAccess(undefined),
      }),
    ).rejects.toThrow("unmarked route: UnmarkedController.get");
  });

  test("the app's routes and their markers (pinned): every src controller, the template module's included", async () => {
    const s = await start(undefined, {
      extraControllers: [],
      config: { OPENAPI_EXPOSURE: "authenticated" },
    });
    // The template module is registered by its own suite only (with its
    // providers), so its controller is read on its own.
    const markers = [
      ...routeMarkers(s.app),
      ...controllerMarkers(TemplateItemsController),
    ];
    expect(markers.filter((m) => m.marker.kind === "unmarked")).toEqual([]);
    // Pinned: the controllers that exist at P5-07. A module copied from
    // the template later (pnpm new-module, whose selftest runs this suite
    // on a copy) adds its own controller; the boot check and the line
    // above hold it to a marker.
    const pinnedControllers = new Set([
      "AccessGrantsController",
      "DevicesController",
      "HealthController",
      "MembersController",
      "MyAccessGrantsController",
      "MyMembershipsController",
      "OpenApiController",
      "ProjectMembersController",
      "PublicOpenApiController",
      "RolesController",
      "SessionsController",
      "TemplateItemsController",
      "UserSessionsController",
    ]);
    const pinned = markers
      .filter((m) => pinnedControllers.has(m.handler.split(".")[0] ?? ""))
      .map((m) => {
        const { marker } = m;
        if (marker.kind === "can") {
          return `${m.route} can ${marker.permission}${marker.projectParam === undefined ? "" : ` @${marker.projectParam}`}`;
        }
        return `${m.route} ${marker.kind}`;
      })
      .sort();
    expect(pinned).toEqual(
      [
        "DELETE /access-grants/:id can org.access_grant.revoke",
        "DELETE /devices/:id none",
        "DELETE /members/:id can org.member.remove",
        "DELETE /projects/:projectId/members/:id can project.member.assign @projectId",
        "DELETE /sessions/:id none",
        "GET /access-grants can org.access_grant.read",
        "GET /access-grants/:id can org.access_grant.read",
        "GET /devices none",
        "GET /health/live public",
        "GET /health/ready public",
        "GET /me/access-grants none",
        "GET /me/memberships none",
        "GET /members can org.member.read",
        "GET /openapi.json none",
        "GET /projects/:projectId/members can project.member.read @projectId",
        "GET /roles can org.role.read",
        "GET /roles/:id can org.role.read",
        "GET /sessions none",
        "GET /template-items can project.milestone.read",
        "GET /template-items/:id can project.milestone.read",
        "GET /users/:userId/sessions can org.session.read",
        "PATCH /members/:id can org.member.update",
        "PATCH /projects/:projectId/members/:id can project.member.assign @projectId",
        "PATCH /roles/:id can org.role.manage",
        "POST /access-grants can org.access_grant.grant",
        "POST /devices none",
        "POST /members can org.member.invite",
        "POST /projects/:projectId/members can project.member.assign @projectId",
        "POST /roles can org.role.manage",
        "POST /roles/:id/archive can org.role.manage",
        "POST /template-items can project.milestone.create",
        "POST /users/:userId/sessions/revoke can org.session.revoke",
      ].sort(),
    );
  });

  test("a @NoPermission route keeps a reason (the coverage list carries it)", async () => {
    const s = await start(undefined, { extraControllers: [] });
    const none = routeMarkers(s.app).filter((m) => m.marker.kind === "none");
    expect(none.length).toBeGreaterThan(0);
    for (const m of none) {
      expect(m.marker.kind === "none" && m.marker.reason.length > 0).toBe(true);
    }
  });
});

describe("scope from the route parameters (DW2)", () => {
  test("an org key at org scope: allowed; without it: 403 forbidden", async () => {
    let s = await start(accessOf([orgGrant("org.role.read")]));
    expect((await call(s, "GET", ROLES)).statusCode).toBe(200);
    await s.app.close();
    s = await start(accessOf([orgGrant("org.member.read")]));
    expectForbidden(await call(s, "GET", ROLES));
  });

  test("a project key: allowed on the project in the path, 403 on another project", async () => {
    const s = await start(accessOf([projectGrant("project.milestone.read")]));
    expect((await call(s, "GET", milestonesOf(PROJECT))).statusCode).toBe(200);
    expectForbidden(await call(s, "GET", milestonesOf(OTHER_PROJECT)));
  });

  test("the same key at org scope covers every project", async () => {
    const s = await start(accessOf([orgGrant("project.milestone.read")]));
    expect((await call(s, "GET", milestonesOf(OTHER_PROJECT))).statusCode).toBe(
      200,
    );
  });

  test("no scope parameter: the action held anywhere in the org passes, nothing held is 403", async () => {
    let s = await start(
      accessOf([projectGrant("project.milestone.read", [OTHER_PROJECT])]),
    );
    expect((await call(s, "GET", ANYWHERE)).statusCode).toBe(200);
    await s.app.close();
    s = await start(accessOf([projectGrant("project.milestone.create")]));
    expectForbidden(await call(s, "GET", ANYWHERE));
  });

  test("a malformed project parameter never matches a project grant (the route's pipe answers it; here nothing held anywhere is 403)", async () => {
    const s = await start(accessOf([]));
    expectForbidden(await call(s, "GET", milestonesOf("not-a-uuid")));
  });

  test("a key held only through an elevation (in grants, not membershipGrants) passes", async () => {
    const s = await start(
      accessOf([projectGrant("project.milestone.read")], []),
    );
    expect((await call(s, "GET", milestonesOf(PROJECT))).statusCode).toBe(200);
  });

  test("no token on a @Can route is 401 unauthenticated: the AuthGuard runs first", async () => {
    const s = await start(accessOf([orgGrant("org.role.read")]));
    const res = await s.app.inject({ method: "GET", url: ROLES });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ code: "unauthenticated" });
  });

  test("a refusal logs one authz.denied line with the permission, never the ids in the path", async () => {
    const s = await start(accessOf([]));
    await call(s, "GET", milestonesOf(OTHER_PROJECT));
    const denied = s.logged().filter((l) => l.msg === "authz.denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ permission: "project.milestone.read" });
    expect(JSON.stringify(denied[0])).not.toContain(OTHER_PROJECT);
  });
});

describe("step-up for finance keys (DW3; D-F as changed, conditions 1 and 3)", () => {
  const finance = [
    projectGrant("finance.payment.approve"),
    projectGrant("finance.payment.request"),
  ];

  test("the challenge header is the RFC 9470 one", () => {
    expect(STEP_UP_CHALLENGE).toBe(
      'Bearer error="insufficient_user_authentication", acr_values="mfa"',
    );
  });

  test("a finance key at acr mfa: allowed, the handler sees acr mfa", async () => {
    const s = await start(accessOf(finance));
    const res = await call(s, "POST", APPROVE, { acr: "mfa" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ approved: true, acr: "mfa" });
  });

  test("a finance key with no acr claim: 401 step-up, never 403, never session_expired", async () => {
    const s = await start(accessOf(finance));
    for (const url of [APPROVE, REQUEST]) {
      const res = await call(s, "POST", url, { acr: undefined });
      expectStepUp(res);
      expect(JSON.parse(res.body)).not.toMatchObject({
        code: "session_expired",
      });
    }
  });

  test.each([
    ["pwd", "pwd"],
    ["upper case", "MFA"],
    ["padded", " mfa"],
    ["another level", "2fa"],
    ["Keycloak's numeric level", "1"],
    ["a number", 2],
    ["an array", ["mfa"]],
    ["an object", { value: "mfa" }],
    ["null", null],
  ])("acr %s counts as pwd: 401 step-up", async (_name, acr) => {
    const s = await start(accessOf(finance));
    expectStepUp(await call(s, "POST", APPROVE, { acr }));
  });

  test("no header turns a pwd token into mfa (condition 4)", async () => {
    const s = await start(accessOf(finance));
    const res = await call(
      s,
      "POST",
      APPROVE,
      { acr: "pwd" },
      {
        acr: "mfa",
        "x-acr": "mfa",
        "x-bricx-acr": "mfa",
        "x-auth-acr": "mfa",
        "x-amr": "otp",
      },
    );
    expectStepUp(res);
  });

  test("a finance key held only through an elevation is refused at pwd too", async () => {
    const s = await start(accessOf(finance, []));
    expectStepUp(await call(s, "POST", APPROVE, { acr: "pwd" }));
  });

  test("a non-finance key at acr pwd: allowed", async () => {
    const s = await start(accessOf([projectGrant("project.milestone.read")]));
    const res = await call(s, "GET", milestonesOf(PROJECT), { acr: "pwd" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ acr: "pwd" });
  });

  test("a finance key the user does not hold: 403 forbidden at any acr (stepping up would not help)", async () => {
    const s = await start(accessOf([projectGrant("finance.payment.read")]));
    expectForbidden(await call(s, "POST", APPROVE, { acr: "pwd" }));
    expectForbidden(await call(s, "POST", APPROVE, { acr: "mfa" }));
  });

  test("a finance key on another project: 403 at any acr", async () => {
    const s = await start(
      accessOf([projectGrant("finance.payment.approve", [OTHER_PROJECT])]),
    );
    expectForbidden(await call(s, "POST", APPROVE, { acr: "mfa" }));
    expectForbidden(await call(s, "POST", APPROVE, { acr: "pwd" }));
  });

  test("a step-up refusal logs one authz.step_up line with the permission", async () => {
    const s = await start(accessOf(finance));
    await call(s, "POST", APPROVE, { acr: "pwd" });
    const lines = s.logged().filter((l) => l.msg === "authz.step_up");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ permission: "finance.payment.approve" });
  });

  test("the finance module's keys are exactly those with MFA_KEY_PREFIX (the guard's rule)", () => {
    const finance = PERMISSIONS.filter((p) => p.startsWith(MFA_KEY_PREFIX));
    expect(finance.length).toBeGreaterThan(0);
    expect(finance.every((p) => p.split(".")[0] === "finance")).toBe(true);
  });
});

describe("the SoD message key is the catalogue's (P5-07, DW9)", () => {
  test("SOD_VIOLATION_KEY (@bricx/permissions) is ERROR_KEYS['permission.sod_violation'], 403; step-up is 401", () => {
    expect(SOD_VIOLATION_KEY).toBe(ERROR_KEYS["permission.sod_violation"]);
    expect(ERROR_STATUS["permission.sod_violation"]).toBe(403);
    expect(ERROR_STATUS["permission.step_up_required"]).toBe(401);
  });
});
