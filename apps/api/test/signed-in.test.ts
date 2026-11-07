// The AuthGuard's P6-02 paths (ADR 0072; D6/D16, D11, owner condition C1),
// with the real guard, real RS256 tokens and test probes:
// - @SignedIn(): the token is verified and the user provisioned with no
//   org; no org claim or header is read, and no grants, revocation or
//   session check runs; the handler reads the signed-in user (id, acr);
//   the authorization guard lets the route through;
// - every other route: an org_id claim that is missing takes X-Org-Id;
//   missing with no header, or malformed with or without one, is 403 and
//   provisions nobody (the P5-02 contract);
// - an archived organisation (the grants source's orgArchived) is 404
//   not_found before any revocation check or session row, except on a
//   route marked @AllowArchivedOrg().
import { loadApiConfig } from "@bricx/config/api";
import { Controller, Get, Post } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { createApp } from "../src/app.js";
import { AllowArchivedOrg } from "../src/common/auth/allow-archived-org.decorator.js";
import { ORG_ID_HEADER } from "../src/common/auth/auth.guard.js";
import { NoPermission } from "../src/common/auth/can.decorator.js";
import type { Access, GrantsSource } from "../src/common/auth/grants-source.js";
import {
  SIGNED_IN_EXTENSION,
  SignedIn,
  signedInUser,
} from "../src/common/auth/signed-in.decorator.js";
import { currentRequestContext } from "../src/common/db/request-context.js";
import { buildOpenApiDocument } from "../src/openapi/document.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";
import {
  TestIssuer,
  bearer,
  fixedRevocations,
  fixedSessions,
  fixedUsers,
} from "./support/auth.js";

const USER = "0199e1a0-0000-7000-8000-000000000801";
const ORG = "0199e1a0-0000-7000-8000-00000000080a";
const OTHER_ORG = "0199e1a0-0000-7000-8000-00000000080b";
const ROUTE = "/v1/signed-in-probe";

@Controller({ path: "signed-in-probe", version: "1" })
class SignedInProbeController {
  @Post()
  @SignedIn()
  create() {
    return {
      user: signedInUser(),
      identity: currentRequestContext()?.identity ?? null,
    };
  }

  @Get("member")
  @NoPermission("test-only probe")
  member() {
    return { org: currentRequestContext()?.identity?.orgId };
  }

  @Get("archived")
  @NoPermission("test-only probe")
  @AllowArchivedOrg()
  archived() {
    return { org: currentRequestContext()?.identity?.orgId };
  }
}

const memberAccess: Access = {
  projectIds: [],
  grants: [],
  membershipGrants: [],
  allProjects: false,
};

let issuer: TestIssuer;
let app: NestFastifyApplication;
let users: ReturnType<typeof fixedUsers>;
let sessions: ReturnType<typeof fixedSessions>;
let revocations: ReturnType<typeof fixedRevocations>;
const grantCalls: { userId: string; orgId: string }[] = [];
let archivedOrgs = new Set<string>();
const grants: GrantsSource = {
  grantsFor(user) {
    grantCalls.push({ ...user });
    return Promise.resolve(
      archivedOrgs.has(user.orgId)
        ? { ...memberAccess, orgArchived: true }
        : memberAccess,
    );
  },
};

beforeAll(async () => {
  issuer = await TestIssuer.start();
  users = fixedUsers({}, USER);
  sessions = fixedSessions();
  revocations = fixedRevocations();
  app = await createApp(loadApiConfig(apiEnv(issuer.env())), {
    probes: fakeProbes(),
    userDirectory: users,
    sessionTracker: sessions,
    revocationStore: revocations,
    grantsSource: grants,
    extraControllers: [SignedInProbeController],
  });
  await app.init();
});
afterAll(async () => {
  await app.close();
  await issuer.close();
});
beforeEach(() => {
  users.provisioned.length = 0;
  sessions.tracked.length = 0;
  revocations.checks.length = 0;
  grantCalls.length = 0;
  archivedOrgs = new Set();
});

const send = async (
  method: "GET" | "POST",
  url: string,
  claims: Record<string, unknown>,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method,
    url,
    headers: { ...bearer(await issuer.token(claims)), ...headers },
  });

const nothingRanAfterProvisioning = () => {
  expect(grantCalls).toEqual([]);
  expect(revocations.checks).toEqual([]);
  expect(sessions.tracked).toEqual([]);
};

describe("@SignedIn() (D11)", () => {
  test("no org_id claim: the user is provisioned without an org, nothing else runs, the handler reads the user and acr; no identity", async () => {
    const res = await send("POST", ROUTE, {
      sub: "signed-in",
      org_id: undefined,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({
      user: { userId: USER, acr: "pwd" },
      identity: null,
    });
    expect(users.provisioned).toEqual([
      { subject: "signed-in", orgId: undefined },
    ]);
    nothingRanAfterProvisioning();
  });

  test("acr mfa is carried as mfa", async () => {
    const res = await send("POST", ROUTE, {
      sub: "signed-in",
      org_id: undefined,
      acr: "mfa",
    });
    expect(res.json()).toMatchObject({ user: { userId: USER, acr: "mfa" } });
  });

  test("an org claim, malformed or not, and X-Org-Id are ignored; a malformed X-Device-Id too (no session)", async () => {
    for (const claims of [
      { sub: "signed-in", org_id: "not-a-uuid" },
      { sub: "signed-in", org_id: ORG },
    ]) {
      const res = await send("POST", ROUTE, claims, {
        [ORG_ID_HEADER]: "bad",
        "x-device-id": "bad",
      });
      expect(res.statusCode, res.body).toBe(201);
    }
    nothingRanAfterProvisioning();
  });

  test("an invalid token is still 401 and provisions nobody", async () => {
    const res = await app.inject({
      method: "POST",
      url: ROUTE,
      headers: bearer(
        await issuer.token({ sub: "signed-in" }, { key: "unpublished" }),
      ),
    });
    expect(res.statusCode).toBe(401);
    expect(users.provisioned).toEqual([]);
  });

  test("the operation carries x-bricx-signed-in", () => {
    const doc = buildOpenApiDocument(app);
    const paths = doc.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    expect(paths[ROUTE]?.post?.[SIGNED_IN_EXTENSION]).toBe(true);
    expect(
      paths[`${ROUTE}/member`]?.get?.[SIGNED_IN_EXTENSION],
    ).toBeUndefined();
  });
});

describe("every other route (C1)", () => {
  test("no org_id claim and no X-Org-Id: 403 forbidden, nobody provisioned", async () => {
    const res = await send("GET", `${ROUTE}/member`, {
      sub: "member",
      org_id: undefined,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "forbidden" });
    expect(users.provisioned).toEqual([]);
    nothingRanAfterProvisioning();
  });

  test("no org_id claim and a valid X-Org-Id: the header's org", async () => {
    const res = await send(
      "GET",
      `${ROUTE}/member`,
      { sub: "member", org_id: undefined },
      { [ORG_ID_HEADER]: ORG },
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ org: ORG });
    expect(grantCalls).toEqual([{ userId: USER, orgId: ORG }]);
  });

  test("no org_id claim and a malformed X-Org-Id: 403, nobody provisioned", async () => {
    const res = await send(
      "GET",
      `${ROUTE}/member`,
      { sub: "member", org_id: undefined },
      { [ORG_ID_HEADER]: "not-a-uuid" },
    );
    expect(res.statusCode).toBe(403);
    expect(users.provisioned).toEqual([]);
  });

  test.each([["not-a-uuid"], [42], [null], [""], [ORG.toUpperCase()]])(
    "a malformed org_id claim (%j) stays 403 even with a valid X-Org-Id; nobody provisioned",
    async (claim) => {
      const res = await send(
        "GET",
        `${ROUTE}/member`,
        { sub: "member", org_id: claim },
        { [ORG_ID_HEADER]: ORG },
      );
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "forbidden" });
      expect(users.provisioned).toEqual([]);
    },
  );

  test("the authorization guard does not let a @SignedIn() marker through on another route: GET /member is still checked", async () => {
    const res = await send("GET", `${ROUTE}/member`, {
      sub: "member",
      org_id: ORG,
    });
    expect(res.statusCode).toBe(200);
    expect(grantCalls).toHaveLength(1);
    expect(sessions.tracked).toHaveLength(1);
  });
});

describe("an archived organisation (D6/D16)", () => {
  test("404 not_found before any revocation check or session row", async () => {
    archivedOrgs.add(ORG);
    const res = await send("GET", `${ROUTE}/member`, {
      sub: "member",
      org_id: ORG,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "not_found" });
    expect(grantCalls).toHaveLength(1);
    expect(revocations.checks).toEqual([]);
    expect(sessions.tracked).toEqual([]);
  });

  test("@AllowArchivedOrg(): the route runs", async () => {
    archivedOrgs.add(ORG);
    const res = await send("GET", `${ROUTE}/archived`, {
      sub: "member",
      org_id: ORG,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ org: ORG });
    expect(sessions.tracked).toHaveLength(1);
  });

  test("another organisation of the same user is not affected", async () => {
    archivedOrgs.add(ORG);
    const res = await send(
      "GET",
      `${ROUTE}/member`,
      { sub: "member", org_id: ORG },
      { [ORG_ID_HEADER]: OTHER_ORG },
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ org: OTHER_ORG });
  });
});
