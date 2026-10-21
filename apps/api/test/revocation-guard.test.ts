// The guard's revocation check (P5-04, ADR 0065; plan decision 6, owner
// condition 1): after the user is provisioned and before the sessions row
// is touched, one check of the org-scoped keys revoked:sid:<org>:<sid> and
// revoked:user:<org>:<user>. A hit is 401 session_expired (auth.failed
// reason revoked_sid or revoked_user, the sid never logged) and nothing is
// tracked; an unreachable store is 503 server_unavailable (fail closed)
// with one auth.revocation_unavailable line. The store itself is proved
// live in revocation-store.int.test.ts.
import { Writable } from "node:stream";
import { loadApiConfig } from "@bricx/config/api";
import { Controller, Get } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { Public } from "../src/common/auth/public.decorator.js";
import {
  REVOCATION_REASONS,
  REVOCATION_TIMEOUT_MS,
  type RevocationReason,
  revocationKeys,
} from "../src/common/auth/revocation-store.js";
import { SESSION_FAILURE_REASONS } from "../src/common/auth/session-tracker.js";
import { AUTH_FAILURE_REASONS } from "../src/common/auth/token-verifier.js";
import { currentRequestContext } from "../src/common/db/request-context.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";
import {
  TEST_SESSION_ID,
  TestIssuer,
  bearer,
  fixedRevocations,
  fixedSessions,
  fixedUsers,
  roleGrants,
  sidFor,
} from "./support/auth.js";

const ORG = "0199e1a0-0000-7000-8000-00000000000a";
const OTHER_ORG = "0199e1a0-0000-7000-8000-00000000000b";
const USER = "0199e1a0-0000-7000-8000-000000000001";
const SUB = "sub-sentinel-9f2a-personal";

@Controller({ path: "whoami", version: "1" })
class WhoAmIController {
  @Get()
  get() {
    return { identity: currentRequestContext()?.identity ?? null };
  }

  @Get("open")
  @Public()
  open() {
    return { ok: true };
  }
}

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
  lines: string[];
  logged: () => Record<string, unknown>[];
  events: string[];
  sessions: ReturnType<typeof fixedSessions>;
  revocations: ReturnType<typeof fixedRevocations>;
}

async function start(
  options: Parameters<typeof fixedRevocations>[0] = {},
): Promise<Started> {
  const lines: string[] = [];
  const events: string[] = [];
  const logStream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
      done();
    },
  });
  const users = fixedUsers({ [SUB]: USER }, USER);
  const provision = users.provision.bind(users);
  users.provision = (input) => {
    events.push("provision");
    return provision(input);
  };
  const sessions = fixedSessions();
  const track = sessions.track.bind(sessions);
  sessions.track = (input) => {
    events.push("track");
    return track(input);
  };
  const revocations = fixedRevocations({
    ...options,
    onCheck: () => events.push("check"),
  });
  app = await createApp(loadApiConfig(apiEnv(issuer.env())), {
    probes: fakeProbes(),
    logStream,
    extraControllers: [WhoAmIController],
    userDirectory: users,
    sessionTracker: sessions,
    revocationStore: revocations,
    grantsSource: roleGrants(),
  });
  await app.init();
  return {
    app,
    lines,
    logged: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
    events,
    sessions,
    revocations,
  };
}

const whoami = (s: Started, headers: Record<string, string> = {}) =>
  s.app.inject({ method: "GET", url: "/v1/whoami", headers });

const token = () => issuer.token({ sub: SUB, org_id: ORG });

/** The body without its traceId, which differs per request. */
function bodyWithoutTrace(body: string): unknown {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  delete parsed.traceId;
  return parsed;
}

const failures = (s: Started) =>
  s.logged().filter((l) => l.msg === "auth.failed");

describe("the keys and the reasons", () => {
  test("revocationKeys(): org-scoped, the sid key and the user key (owner condition 1)", () => {
    expect(
      revocationKeys({ orgId: ORG, userId: USER, keycloakSid: "sid-a" }),
    ).toEqual({
      sid: `revoked:sid:${ORG}:sid-a`,
      user: `revoked:user:${ORG}:${USER}`,
    });
  });

  test("the reasons are their own catalogue, none a token or a session reason", () => {
    expect([...REVOCATION_REASONS]).toEqual(["revoked_sid", "revoked_user"]);
    for (const reason of REVOCATION_REASONS) {
      expect(AUTH_FAILURE_REASONS).not.toContain(reason);
      expect(SESSION_FAILURE_REASONS).not.toContain(reason);
    }
  });

  test("the check is bounded at 500 ms", () => {
    expect(REVOCATION_TIMEOUT_MS).toBe(500);
  });
});

describe("the guard's check", () => {
  test("runs once per request, after provisioning and before the session is tracked, with the org, the user and the sid", async () => {
    const s = await start();
    const res = await whoami(s, bearer(await token()));
    expect(res.statusCode).toBe(200);
    expect(s.events).toEqual(["provision", "check", "track"]);
    expect(s.revocations.checks).toEqual([
      { orgId: ORG, userId: USER, keycloakSid: sidFor(SUB) },
    ]);
    expect(s.sessions.tracked).toHaveLength(1);
    expect(
      res.json<{ identity: { sessionId: string } }>().identity.sessionId,
    ).toBe(TEST_SESSION_ID);
  });

  test("a public route is not checked", async () => {
    const s = await start();
    const res = await s.app.inject({ method: "GET", url: "/v1/whoami/open" });
    expect(res.statusCode).toBe(200);
    expect(s.revocations.checks).toEqual([]);
  });

  const hits: [RevocationReason, Parameters<typeof fixedRevocations>[0]][] = [
    ["revoked_sid", { sids: [`${ORG}/${sidFor(SUB)}`] }],
    ["revoked_user", { users: [`${ORG}/${USER}`] }],
    [
      "revoked_sid",
      { sids: [`${ORG}/${sidFor(SUB)}`], users: [`${ORG}/${USER}`] },
    ],
  ];

  test.each(hits)(
    "%s: 401 session_expired with WWW-Authenticate: Bearer, one auth.failed line, nothing tracked, no sid or sub logged",
    async (reason, options) => {
      const s = await start(options);
      const res = await whoami(s, bearer(await token()));
      expect(res.statusCode).toBe(401);
      expect(res.headers["www-authenticate"]).toBe("Bearer");
      expect(bodyWithoutTrace(res.body)).toEqual({
        status: 401,
        code: "session_expired",
        key: "errors:session_expired",
      });
      expect(failures(s).map((l) => l.reason)).toEqual([reason]);
      expect(s.events).toEqual(["provision", "check"]);
      expect(s.sessions.tracked).toEqual([]);
      const all = s.lines.join("\n");
      expect(all).not.toContain(sidFor(SUB));
      expect(all).not.toContain(SUB);
    },
  );

  test("the keys are org-scoped: a revoke in another org does not touch this one", async () => {
    const s = await start({
      sids: [`${OTHER_ORG}/${sidFor(SUB)}`],
      users: [`${OTHER_ORG}/${USER}`],
    });
    expect((await whoami(s, bearer(await token()))).statusCode).toBe(200);
  });

  test("the store unreachable: 503 server_unavailable (fail closed), no WWW-Authenticate, one auth.revocation_unavailable warn line, no auth.failed, nothing tracked", async () => {
    const s = await start({ unavailable: true });
    const res = await whoami(s, bearer(await token()));
    expect(res.statusCode).toBe(503);
    expect(res.headers["www-authenticate"]).toBeUndefined();
    expect(bodyWithoutTrace(res.body)).toEqual({
      status: 503,
      code: "server_unavailable",
      key: "errors:server_unavailable",
    });
    const warned = s
      .logged()
      .filter((l) => l.msg === "auth.revocation_unavailable");
    expect(warned).toHaveLength(1);
    expect(warned[0]?.level).toBe(40);
    expect(failures(s)).toEqual([]);
    expect(s.events).toEqual(["provision", "check"]);
    expect(s.sessions.tracked).toEqual([]);
    expect(s.lines.join("\n")).not.toContain(SUB);
  });

  test("every revocation reason is a 401 session_expired (the catalogue is covered above)", () => {
    expect([...new Set(hits.map(([r]) => r))].sort()).toEqual(
      [...REVOCATION_REASONS].sort(),
    );
  });
});
