// P5-02 (ADR 0062; owner conditions 4, 5 and 6): the global AuthGuard
// with real RS256 tokens from a local JWKS (test/support/auth.ts), no
// database (a fixed user directory). Every token failure is the same 401
// `unauthenticated` with `WWW-Authenticate: Bearer`; the reason goes to
// one `auth.failed` log line only. RS256 only, iss, aud bricx-api, exp and
// nbf with a 5 s tolerance against the injected Clock, sub non-empty, typ
// Bearer. A valid token without a UUIDv7 org_id is 403 and nothing is
// provisioned. JWKS keys are cached (one fetch for many requests); unknown
// kids refetch at most once per cooldown; a JWKS that is down or slow is
// 503, and its failures are cooled down too.
import { Writable } from "node:stream";
import { loadApiConfig } from "@bricx/config/api";
import { can } from "@bricx/permissions/ability";
import { ErrorEnvelopeSchema } from "@bricx/validation/error-envelope";
import { Controller, Get, Inject } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  SignJWT,
  UnsecuredJWT,
  errors,
  exportSPKI,
  generateKeyPair,
} from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { type CreateAppOptions, createApp } from "../src/app.js";
import { abilityFor } from "../src/common/auth/ability.js";
import type { GrantsSource } from "../src/common/auth/grants-source.js";
import { Public } from "../src/common/auth/public.decorator.js";
import {
  AUTH_FAILURE_REASONS,
  CLOCK_TOLERANCE_SECONDS,
  MAX_TOKEN_LENGTH,
  TOKEN_ALGORITHMS,
  reasonFor,
} from "../src/common/auth/token-verifier.js";
import type { Clock } from "../src/common/clock.js";
import { currentRequestContext } from "../src/common/db/request-context.js";
import { TxRunner } from "../src/common/db/tx-runner.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";
import {
  TestIssuer,
  bearer,
  fixedAccess,
  fixedUsers,
  roleGrants,
} from "./support/auth.js";

const ORG = "0199e1a0-0000-7000-8000-00000000000a";
const USER = "0199e1a0-0000-7000-8000-000000000001";
const PROJECT = "0199e1a0-0000-7000-8000-000000000010";
const SUB = "sub-sentinel-5d1c-personal";

@Controller({ path: "whoami", version: "1" })
class WhoAmIController {
  constructor(@Inject(TxRunner) private readonly runner: TxRunner) {}

  @Get()
  get() {
    const identity = currentRequestContext()?.identity;
    return {
      identity: identity ?? null,
      canCreate:
        identity === undefined
          ? null
          : can(abilityFor(identity), "create", "project.milestone", {
              orgId: ORG,
              projectId: PROJECT,
              createdBy: identity.userId,
            }),
    };
  }

  @Get("open")
  @Public()
  open() {
    return { identity: currentRequestContext()?.identity ?? null };
  }
}

let issuer: TestIssuer;
beforeAll(async () => {
  issuer = await TestIssuer.start();
});
afterAll(async () => {
  await issuer.close();
});

/** A clock the tests move; starts at the real time. */
function testClock(): Clock & { offsetMs: number } {
  const clock = {
    offsetMs: 0,
    now: () => Date.now() + clock.offsetMs,
  };
  return clock;
}

interface Started {
  app: NestFastifyApplication;
  lines: string[];
  logged: () => Record<string, unknown>[];
  users: ReturnType<typeof fixedUsers>;
  clock: ReturnType<typeof testClock>;
}

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  issuer.down = false;
  issuer.hang = false;
});

async function start(
  options: Partial<CreateAppOptions> & { grants?: GrantsSource } = {},
): Promise<Started> {
  const lines: string[] = [];
  const logStream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
      done();
    },
  });
  const users = fixedUsers({ [SUB]: USER }, USER);
  const clock = testClock();
  app = await createApp(loadApiConfig(apiEnv(issuer.env())), {
    probes: fakeProbes(),
    logStream,
    extraControllers: [WhoAmIController],
    userDirectory: users,
    grantsSource:
      options.grants ??
      roleGrants({
        [USER]: { projects: [PROJECT], roles: ["project_manager"] },
      }),
    clock,
    ...options,
  });
  await app.init();
  return {
    app,
    lines,
    logged: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
    users,
    clock,
  };
}

const whoami = (s: Started, headers: Record<string, string> = {}) =>
  s.app.inject({ method: "GET", url: "/v1/whoami", headers });

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** The body without its traceId, which differs per request. */
function bodyWithoutTrace(body: string): unknown {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  delete parsed.traceId;
  return parsed;
}

const failures = (s: Started) =>
  s.logged().filter((l) => l.msg === "auth.failed");

function expectUnauthenticated(res: {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
}) {
  expect(res.statusCode).toBe(401);
  expect(res.headers["www-authenticate"]).toBe("Bearer");
  expect(String(res.headers["content-type"])).toContain(
    "application/problem+json",
  );
  const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(res.body));
  expect(parsed.success).toBe(true);
  expect(bodyWithoutTrace(res.body)).toEqual({
    status: 401,
    code: "unauthenticated",
    key: "errors:unauthenticated",
  });
}

describe("the constants the ADR fixes", () => {
  test("RS256 only, 5 s tolerance, 8 KiB tokens", () => {
    expect(TOKEN_ALGORITHMS).toEqual(["RS256"]);
    expect(CLOCK_TOLERANCE_SECONDS).toBe(5);
    expect(MAX_TOKEN_LENGTH).toBe(8_192);
  });
});

describe("a valid token", () => {
  test("200: org from the claim, user from the directory, projects and grants from the grants source; no roles", async () => {
    const s = await start();
    const res = await whoami(
      s,
      bearer(await issuer.token({ sub: SUB, org_id: ORG })),
    );
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      identity: Record<string, unknown>;
      canCreate: boolean;
    }>();
    expect(body.identity).toMatchObject({
      orgId: ORG,
      userId: USER,
      projectIds: [PROJECT],
    });
    expect(body.identity).not.toHaveProperty("roles");
    expect(body.canCreate).toBe(true);
    expect(s.users.provisioned).toEqual([{ subject: SUB, orgId: ORG }]);
    expect(failures(s)).toEqual([]);
  });

  test("production's default grants source denies: nothing is allowed before P5-05", async () => {
    const s = await start({
      grants: fixedAccess({ projectIds: [], grants: [] }),
    });
    const res = await whoami(
      s,
      bearer(await issuer.token({ sub: SUB, org_id: ORG })),
    );
    expect(res.json()).toMatchObject({
      identity: { orgId: ORG, userId: USER, projectIds: [], grants: [] },
      canCreate: false,
    });
  });

  test("an exp within the 5 s tolerance is accepted; the header typ is not checked (Keycloak sends JWT)", async () => {
    const s = await start();
    const token = await issuer.token(
      { sub: SUB, org_id: ORG, exp: nowSeconds() - 3 },
      { headerTyp: "at+jwt" },
    );
    expect((await whoami(s, bearer(token))).statusCode).toBe(200);
  });

  test("the bearer scheme is case-insensitive", async () => {
    const s = await start();
    const token = await issuer.token({ sub: SUB, org_id: ORG });
    const res = await whoami(s, { authorization: `bearer ${token}` });
    expect(res.statusCode).toBe(200);
  });

  test("a new user logs one auth.provisioned line, with no sub and no token", async () => {
    const s = await start();
    const token = await issuer.token({ sub: SUB, org_id: ORG });
    await whoami(s, bearer(token));
    await whoami(s, bearer(token));
    const provisioned = s.logged().filter((l) => l.msg === "auth.provisioned");
    expect(provisioned).toHaveLength(1);
    expect(provisioned[0]).toMatchObject({ userId: USER, orgId: ORG });
    const all = s.lines.join("\n");
    expect(all).not.toContain(SUB);
    expect(all).not.toContain(token);
    expect(all).not.toContain(token.split(".")[2]);
  });

  test("a public route skips the guard: no token, or a bad one, and no identity", async () => {
    const s = await start();
    for (const headers of [{}, { authorization: "Bearer nonsense" }]) {
      const res = await s.app.inject({
        method: "GET",
        url: "/v1/whoami/open",
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ identity: null });
    }
    expect(s.users.provisioned).toEqual([]);
  });

  test("grants the source returns that are not valid grants fail the request before the handler (500)", async () => {
    const bad: GrantsSource = {
      grantsFor: () =>
        Promise.resolve({
          projectIds: [PROJECT],
          grants: [
            JSON.parse(
              '{"permission":"project.milestone.create","scope":"everything"}',
            ) as never,
          ],
        }),
    };
    const s = await start({ grants: bad });
    const res = await whoami(
      s,
      bearer(await issuer.token({ sub: SUB, org_id: ORG })),
    );
    expect(res.statusCode).toBe(500);
  });
});

describe("every token failure: the same 401 unauthenticated, one auth.failed line with its reason", () => {
  async function hs256WithPublicKey(): Promise<string> {
    // The classic confusion: HMAC keyed with the RSA public key's text.
    const { publicKey } = await generateKeyPair("RS256", { extractable: true });
    const secret = new TextEncoder().encode(await exportSPKI(publicKey));
    return new SignJWT({
      iss: issuer.issuer,
      aud: "bricx-api",
      typ: "Bearer",
      sub: SUB,
      org_id: ORG,
    })
      .setProtectedHeader({ alg: "HS256", kid: issuer.kid })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(secret);
  }

  const cases: [
    string,
    () => Promise<Record<string, string>>,
    (typeof AUTH_FAILURE_REASONS)[number],
  ][] = [
    ["no Authorization header", () => Promise.resolve({}), "token_missing"],
    [
      "another scheme",
      async () => ({
        authorization: `Basic ${await issuer.token({ sub: SUB, org_id: ORG })}`,
      }),
      "token_malformed",
    ],
    [
      "not a JWT",
      () => Promise.resolve({ authorization: "Bearer abc.def" }),
      "token_malformed",
    ],
    [
      "an empty bearer",
      () => Promise.resolve({ authorization: "Bearer " }),
      "token_malformed",
    ],
    [
      "a token over 8 KiB",
      async () =>
        bearer(
          await issuer.token({
            sub: SUB,
            org_id: ORG,
            pad: "x".repeat(MAX_TOKEN_LENGTH),
          }),
        ),
      "token_malformed",
    ],
    [
      "garbage in the JWT parts",
      () => Promise.resolve(bearer("e30.e30.e30")),
      "token_malformed",
    ],
    [
      "alg none",
      () =>
        Promise.resolve(
          bearer(
            new UnsecuredJWT({
              iss: issuer.issuer,
              aud: "bricx-api",
              typ: "Bearer",
              sub: SUB,
              org_id: ORG,
            })
              .setIssuedAt()
              .setExpirationTime("5m")
              .encode(),
          ),
        ),
      "alg_refused",
    ],
    [
      "HS256 keyed with the public key",
      async () => bearer(await hs256WithPublicKey()),
      "alg_refused",
    ],
    [
      "an RS256 key the JWKS does not publish (unknown kid)",
      async () =>
        bearer(
          await issuer.token({ sub: SUB, org_id: ORG }, { key: "unpublished" }),
        ),
      "key_unknown",
    ],
    [
      "an unpublished key presenting the published kid",
      async () =>
        bearer(
          await issuer.token(
            { sub: SUB, org_id: ORG },
            { key: "unpublished", kid: issuer.kid },
          ),
        ),
      "signature_invalid",
    ],
    [
      "a tampered payload",
      async () => {
        const [h, , sig] = (
          await issuer.token({ sub: SUB, org_id: ORG })
        ).split(".");
        const forged = Buffer.from(
          JSON.stringify({
            iss: issuer.issuer,
            aud: "bricx-api",
            typ: "Bearer",
            sub: "someone-else",
            org_id: ORG,
            exp: nowSeconds() + 300,
          }),
        ).toString("base64url");
        return bearer(`${String(h)}.${forged}.${String(sig)}`);
      },
      "signature_invalid",
    ],
    [
      "another issuer",
      async () =>
        bearer(
          await issuer.token({
            sub: SUB,
            org_id: ORG,
            iss: "http://127.0.0.1:1/realms/other",
          }),
        ),
      "issuer_mismatch",
    ],
    [
      "no issuer",
      async () =>
        bearer(await issuer.token({ sub: SUB, org_id: ORG, iss: undefined })),
      "issuer_mismatch",
    ],
    [
      "another audience",
      async () =>
        bearer(await issuer.token({ sub: SUB, org_id: ORG, aud: "account" })),
      "audience_mismatch",
    ],
    [
      "no audience",
      async () =>
        bearer(await issuer.token({ sub: SUB, org_id: ORG, aud: undefined })),
      "audience_mismatch",
    ],
    [
      "expired beyond the tolerance",
      async () =>
        bearer(
          await issuer.token({
            sub: SUB,
            org_id: ORG,
            exp: nowSeconds() - CLOCK_TOLERANCE_SECONDS - 5,
          }),
        ),
      "expired",
    ],
    [
      "no exp",
      async () =>
        bearer(await issuer.token({ sub: SUB, org_id: ORG, exp: undefined })),
      "token_malformed",
    ],
    [
      "nbf in the future beyond the tolerance",
      async () =>
        bearer(
          await issuer.token({
            sub: SUB,
            org_id: ORG,
            nbf: nowSeconds() + CLOCK_TOLERANCE_SECONDS + 30,
          }),
        ),
      "not_yet_valid",
    ],
    [
      "no sub",
      async () => bearer(await issuer.token({ sub: undefined, org_id: ORG })),
      "subject_missing",
    ],
    [
      "an empty sub",
      async () => bearer(await issuer.token({ sub: "", org_id: ORG })),
      "subject_missing",
    ],
    [
      "a sub over 255 characters",
      async () =>
        bearer(await issuer.token({ sub: "s".repeat(256), org_id: ORG })),
      "subject_missing",
    ],
    // P5-03 (P5-02 review point b): a sub that provisionUser() would
    // refuse (printable ASCII only) is refused here, so it is a 401 and
    // never a 500 from UserProvisionError.
    [
      "a sub with a space",
      async () =>
        bearer(await issuer.token({ sub: "sub with space", org_id: ORG })),
      "subject_missing",
    ],
    [
      "a sub with a non-ASCII character",
      async () => bearer(await issuer.token({ sub: "sub-é", org_id: ORG })),
      "subject_missing",
    ],
    [
      "a sub with a control character",
      async () => bearer(await issuer.token({ sub: "sub\u0007", org_id: ORG })),
      "subject_missing",
    ],
    [
      "typ ID (an ID token)",
      async () =>
        bearer(await issuer.token({ sub: SUB, org_id: ORG, typ: "ID" })),
      "type_refused",
    ],
    [
      "typ Refresh",
      async () =>
        bearer(await issuer.token({ sub: SUB, org_id: ORG, typ: "Refresh" })),
      "type_refused",
    ],
    [
      "no typ",
      async () =>
        bearer(await issuer.token({ sub: SUB, org_id: ORG, typ: undefined })),
      "type_refused",
    ],
  ];

  test.each(cases)("%s", async (_what, headersOf, reason) => {
    const s = await start();
    const headers = await headersOf();
    const res = await whoami(s, headers);
    expectUnauthenticated(res);
    expect(failures(s).map((l) => l.reason)).toEqual([reason]);
    expect(s.users.provisioned).toEqual([]);
    const all = s.lines.join("\n");
    expect(all).not.toContain(SUB);
    const token = headers.authorization?.split(" ")[1];
    if (token !== undefined && token.length > 10) {
      expect(all).not.toContain(token);
    }
  });

  test("every reason in the catalogue but the 403 and 503 ones is raised above", () => {
    const raised = new Set(cases.map(([, , reason]) => reason));
    expect(
      AUTH_FAILURE_REASONS.filter(
        (r) => r !== "org_missing" && r !== "jwks_unavailable",
      ).filter((r) => !raised.has(r)),
    ).toEqual([]);
  });

  // P5-03 (P5-02 review point a): an error jose did not classify is the
  // token's problem (401), never a 503; only JWKS failures are 503.
  describe("reasonFor()", () => {
    test("an unclassified error is token_malformed", () => {
      expect(reasonFor(new Error("something else"))).toBe("token_malformed");
      expect(reasonFor(new TypeError("not a jose error"))).toBe(
        "token_malformed",
      );
      expect(reasonFor("a string")).toBe("token_malformed");
      expect(reasonFor(undefined)).toBe("token_malformed");
    });

    test("only JWKS failures are jwks_unavailable", () => {
      expect(reasonFor(new errors.JWKSTimeout())).toBe("jwks_unavailable");
      expect(reasonFor(new errors.JWKSInvalid())).toBe("jwks_unavailable");
      expect(reasonFor(new errors.JWKInvalid())).toBe("jwks_unavailable");
      expect(reasonFor(new errors.JWKSNoMatchingKey())).toBe("key_unknown");
    });
  });

  test("a JWKS fetch that rejects with a plain error is still 503 jwks_unavailable (a real JWKS failure)", async () => {
    const s = await start({
      jwks: { fetch: () => Promise.reject(new TypeError("fetch failed")) },
    });
    const res = await whoami(
      s,
      bearer(await issuer.token({ sub: SUB, org_id: ORG })),
    );
    expect(res.statusCode).toBe(503);
    expect(failures(s).map((l) => l.reason)).toEqual(["jwks_unavailable"]);
  });

  test("the 401 bodies are identical apart from the trace id", async () => {
    const s = await start();
    const bodies = new Set<string>();
    for (const [, headersOf] of cases) {
      const res = await whoami(s, await headersOf());
      bodies.add(JSON.stringify(bodyWithoutTrace(res.body)));
    }
    expect(bodies.size).toBe(1);
  });

  test("the Clock decides expiry: a token valid now is expired once the injected clock passes exp + 5 s", async () => {
    const s = await start();
    const token = await issuer.token({
      sub: SUB,
      org_id: ORG,
      exp: nowSeconds() + 60,
    });
    expect((await whoami(s, bearer(token))).statusCode).toBe(200);
    s.clock.offsetMs = (60 + CLOCK_TOLERANCE_SECONDS - 2) * 1000;
    expect((await whoami(s, bearer(token))).statusCode).toBe(200);
    s.clock.offsetMs = (60 + CLOCK_TOLERANCE_SECONDS + 2) * 1000;
    expectUnauthenticated(await whoami(s, bearer(token)));
    expect(failures(s).map((l) => l.reason)).toEqual(["expired"]);
  });

  test("the Clock decides nbf too: moved back, a fresh token is not yet valid", async () => {
    const s = await start();
    const token = await issuer.token({
      sub: SUB,
      org_id: ORG,
      nbf: nowSeconds(),
    });
    s.clock.offsetMs = -60_000;
    expectUnauthenticated(await whoami(s, bearer(token)));
    expect(failures(s).map((l) => l.reason)).toEqual(["not_yet_valid"]);
  });
});

describe("org_id is a hint that must be a UUIDv7 (D7)", () => {
  test.each([
    ["missing", undefined],
    ["not a UUID", "org-1"],
    ["uppercase", ORG.toUpperCase()],
    ["a UUIDv4", "0199e1a0-0000-4000-8000-00000000000a"],
    ["a number", 7],
    ["an array", [ORG]],
  ])(
    "%s: 403 forbidden, reason org_missing, nothing provisioned",
    async (_what, org) => {
      const s = await start();
      const res = await whoami(
        s,
        bearer(await issuer.token({ sub: SUB, org_id: org })),
      );
      expect(res.statusCode).toBe(403);
      expect(bodyWithoutTrace(res.body)).toEqual({
        status: 403,
        code: "forbidden",
        key: "errors:forbidden",
      });
      expect(res.headers["www-authenticate"]).toBeUndefined();
      expect(failures(s).map((l) => l.reason)).toEqual(["org_missing"]);
      expect(s.users.provisioned).toEqual([]);
      expect(s.lines.join("\n")).not.toContain(SUB);
    },
  );
});

describe("the JWKS", () => {
  test("is fetched once for many requests", async () => {
    const before = issuer.fetches;
    const s = await start();
    const token = await issuer.token({ sub: SUB, org_id: ORG });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => whoami(s, bearer(token))),
    );
    for (const res of results) expect(res.statusCode).toBe(200);
    for (let i = 0; i < 10; i += 1) await whoami(s, bearer(token));
    expect(issuer.fetches - before).toBe(1);
  });

  test("many unknown-kid tokens cause bounded fetches (the cooldown)", async () => {
    const s = await start();
    const valid = await issuer.token({ sub: SUB, org_id: ORG });
    await whoami(s, bearer(valid));
    const before = issuer.fetches;
    const unknown = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        issuer.token(
          { sub: SUB, org_id: ORG },
          { key: "unpublished", kid: `unknown-${String(i)}` },
        ),
      ),
    );
    const parallel = await Promise.all(
      unknown.map((token) => whoami(s, bearer(token))),
    );
    for (const token of unknown) await whoami(s, bearer(token));
    for (const res of parallel) expect(res.statusCode).toBe(401);
    // Inside the cooldown after the first fetch: no refetch at all.
    expect(issuer.fetches - before).toBe(0);
    expect(new Set(failures(s).map((l) => l.reason))).toEqual(
      new Set(["key_unknown"]),
    );
  });

  test("rotation: with the cooldown overridden, the new kid triggers one refetch and is accepted; the old key is refused", async () => {
    const s = await start({ jwks: { cooldownMs: 0 } });
    const old = await issuer.token({ sub: SUB, org_id: ORG });
    expect((await whoami(s, bearer(old))).statusCode).toBe(200);
    await issuer.rotate();
    const before = issuer.fetches;
    const fresh = await issuer.token({ sub: SUB, org_id: ORG });
    expect((await whoami(s, bearer(fresh))).statusCode).toBe(200);
    expect(issuer.fetches - before).toBe(1);
    expect((await whoami(s, bearer(fresh))).statusCode).toBe(200);
    expect(issuer.fetches - before).toBe(1);
    expectUnauthenticated(await whoami(s, bearer(old)));
    expect(failures(s).map((l) => l.reason)).toEqual(["key_unknown"]);
  });

  test("down: 503 server_unavailable (never 401), reason jwks_unavailable; failures are cooled down", async () => {
    issuer.down = true;
    const s = await start();
    const token = await issuer.token({ sub: SUB, org_id: ORG });
    const before = issuer.fetches;
    for (let i = 0; i < 5; i += 1) {
      const res = await whoami(s, bearer(token));
      expect(res.statusCode).toBe(503);
      expect(bodyWithoutTrace(res.body)).toMatchObject({
        code: "server_unavailable",
      });
      expect(res.headers["www-authenticate"]).toBeUndefined();
    }
    expect(issuer.fetches - before).toBe(1);
    expect(new Set(failures(s).map((l) => l.reason))).toEqual(
      new Set(["jwks_unavailable"]),
    );
    // After the failure cooldown (on the injected clock) it tries again.
    issuer.down = false;
    s.clock.offsetMs = 60_000;
    const fresh = await issuer.token({
      sub: SUB,
      org_id: ORG,
      exp: nowSeconds() + 600,
    });
    expect((await whoami(s, bearer(fresh))).statusCode).toBe(200);
    expect(issuer.fetches - before).toBe(2);
  });

  test("slow: the fetch times out (timeout overridden) and the answer is 503", async () => {
    issuer.hang = true;
    const s = await start({ jwks: { timeoutMs: 200 } });
    const res = await whoami(
      s,
      bearer(await issuer.token({ sub: SUB, org_id: ORG })),
    );
    expect(res.statusCode).toBe(503);
    expect(failures(s).map((l) => l.reason)).toEqual(["jwks_unavailable"]);
  });
});
