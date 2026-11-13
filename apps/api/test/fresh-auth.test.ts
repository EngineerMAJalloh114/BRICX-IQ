// P6-06c (ADR 0085; owner condition C4, answer Q3 as changed 2026-11-12):
// the token's auth_time and the @FreshAuth() guard.
// - Every route (the verifier): an auth_time claim that is present but not
//   a non-negative JSON integer (a string, a float, a negative number, a
//   number past 2^53) is the same 401 unauthenticated as every token
//   failure, with one auth.failed line, reason auth_time_invalid. A
//   missing, stale or future auth_time passes on a route without
//   @FreshAuth() (clock drift on a developer's machine must not lock
//   every route).
// - A @FreshAuth() route: acr must be mfa and auth_time present, at most
//   now + 5 s (the verifier's clock tolerance) and at most 300 s old (the
//   constant), on the injected Clock. Otherwise 401 auth.reauth_required
//   with an RFC 9470 challenge naming acr_values="mfa" and max_age=300, and
//   one auth.reauth_required line with the cause (no token, no subject).
//   Exactly 300 s passes, 301 s does not; iat never stands in for
//   auth_time (a refreshed token has a new iat and its old auth_time).
import { Writable } from "node:stream";
import { loadApiConfig } from "@bricx/config/api";
import { ErrorEnvelopeSchema } from "@bricx/validation/error-envelope";
import { Controller, Get } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { NoPermission } from "../src/common/auth/can.decorator.js";
import {
  FRESH_AUTH_MAX_AGE_SECONDS,
  FreshAuth,
  REAUTH_CHALLENGE,
} from "../src/common/auth/fresh-auth.js";
import {
  AUTH_FAILURE_REASONS,
  AUTH_TIME_FAILURE_REASONS,
  CLOCK_TOLERANCE_SECONDS,
} from "../src/common/auth/token-verifier.js";
import type { Clock } from "../src/common/clock.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";
import {
  TestIssuer,
  bearer,
  fixedRevocations,
  fixedSessions,
  fixedUsers,
  roleGrants,
} from "./support/auth.js";

const ORG = "0199e1a0-0000-7000-8000-00000000006a";
const USER = "0199e1a0-0000-7000-8000-000000000061";
const SUB = "sub-sentinel-6c01-fresh";
const DEVICE = "0199e1a0-0000-7000-8000-0000000000d6";

@NoPermission("test-only probe")
@Controller({ path: "fresh-probe", version: "1" })
class FreshProbeController {
  @Get("plain")
  plain() {
    return { ok: true };
  }

  @Get("fresh")
  @FreshAuth()
  fresh() {
    return { ok: true };
  }
}

let issuer: TestIssuer;
let app: NestFastifyApplication | undefined;
const lines: string[] = [];
/** Whole seconds, so auth_time arithmetic is exact. */
let nowMs = 0;
const clock: Clock = { now: () => nowMs };
const nowS = () => Math.floor(nowMs / 1000);

beforeAll(async () => {
  issuer = await TestIssuer.start();
});
afterAll(async () => {
  await issuer.close();
});
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(): Promise<NestFastifyApplication> {
  lines.length = 0;
  nowMs = Math.floor(Date.now() / 1000) * 1000;
  issuer.nowSeconds = nowS;
  app = await createApp(loadApiConfig(apiEnv(issuer.env())), {
    probes: fakeProbes(),
    revocationStore: fixedRevocations(),
    sessionTracker: fixedSessions({ devices: [DEVICE] }),
    userDirectory: fixedUsers({ [SUB]: USER }, USER),
    grantsSource: roleGrants(),
    clock,
    extraControllers: [FreshProbeController],
    logStream: new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
        done();
      },
    }),
  });
  await app.init();
  return app;
}

const logged = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

async function get(
  path: "plain" | "fresh",
  claims: Record<string, unknown>,
): Promise<Awaited<ReturnType<NestFastifyApplication["inject"]>>> {
  if (app === undefined) throw new Error("not started");
  return app.inject({
    method: "GET",
    url: `/v1/fresh-probe/${path}`,
    headers: bearer(
      await issuer.token({ sub: SUB, org_id: ORG, acr: "mfa", ...claims }),
    ),
  });
}

function expectReauth(res: {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
}) {
  expect(res.statusCode, res.body).toBe(401);
  const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(res.body));
  expect(parsed.success).toBe(true);
  expect(parsed.data).toMatchObject({
    status: 401,
    code: "auth.reauth_required",
    key: "errors:auth.reauth_required",
  });
  const challenge = String(res.headers["www-authenticate"]);
  expect(challenge).toBe(REAUTH_CHALLENGE);
  expect(challenge).toContain('error="insufficient_user_authentication"');
  expect(challenge).toContain('acr_values="mfa"');
  expect(challenge).toContain(`max_age=${String(FRESH_AUTH_MAX_AGE_SECONDS)}`);
}

describe("the constants", () => {
  test("a 300 s window and the verifier's 5 s skew; auth_time_invalid is its own reason, beside the token reasons", () => {
    expect(FRESH_AUTH_MAX_AGE_SECONDS).toBe(300);
    expect(CLOCK_TOLERANCE_SECONDS).toBe(5);
    expect(AUTH_TIME_FAILURE_REASONS).toEqual(["auth_time_invalid"]);
    for (const reason of AUTH_TIME_FAILURE_REASONS) {
      expect(AUTH_FAILURE_REASONS).not.toContain(reason);
    }
  });
});

describe("every route: a malformed auth_time is 401 auth_time_invalid (Q3)", () => {
  const malformed: [string, unknown][] = [
    ["a string", "1700000000"],
    ["a float", 1_700_000_000.5],
    ["a negative number", -1],
    ["past 2^53", 2 ** 53 + 2],
    ["an object", { s: 1 }],
    ["null", null],
    ["a boolean", true],
  ];
  for (const [label, value] of malformed) {
    test(`${label}: 401 unauthenticated on a plain route and on a fresh route, reason auth_time_invalid`, async () => {
      await start();
      for (const path of ["plain", "fresh"] as const) {
        const res = await get(path, { auth_time: value });
        expect(res.statusCode, res.body).toBe(401);
        expect(res.headers["www-authenticate"]).toBe("Bearer");
        expect(JSON.parse(res.body)).toMatchObject({
          code: "unauthenticated",
        });
      }
      const reasons = logged()
        .filter((l) => l["msg"] === "auth.failed")
        .map((l) => l["reason"]);
      expect(reasons).toEqual(["auth_time_invalid", "auth_time_invalid"]);
    });
  }

  test("missing, stale or in the future: a plain route still answers 200", async () => {
    await start();
    for (const claims of [
      {},
      { auth_time: nowS() - 86_400 },
      { auth_time: nowS() + 3_600 },
      { auth_time: 0 },
    ]) {
      expect((await get("plain", claims)).statusCode).toBe(200);
    }
    expect(logged().filter((l) => l["msg"] === "auth.failed")).toEqual([]);
  });
});

describe("@FreshAuth(): acr mfa and auth_time within 300 s on the Clock", () => {
  test("now, 300 s ago and 5 s ahead pass; 301 s ago, 6 s ahead, missing or acr pwd are 401 auth.reauth_required with the challenge", async () => {
    await start();
    for (const authTime of [nowS(), nowS() - 300, nowS() + 5]) {
      const res = await get("fresh", { auth_time: authTime });
      expect(res.statusCode, `auth_time ${String(authTime)}`).toBe(200);
    }
    const refused: [string, Record<string, unknown>][] = [
      ["stale", { auth_time: nowS() - 301 }],
      ["future", { auth_time: nowS() + 6 }],
      ["missing", {}],
      ["acr pwd", { acr: "pwd", auth_time: nowS() }],
      ["acr absent", { acr: undefined, auth_time: nowS() }],
    ];
    for (const [, claims] of refused) {
      expectReauth(await get("fresh", claims));
    }
    const causes = logged()
      .filter((l) => l["msg"] === "auth.reauth_required")
      .map((l) => l["cause"]);
    expect(causes).toEqual(["stale", "future", "missing", "acr", "acr"]);
    // No token, no subject in any line.
    expect(lines.join("\n")).not.toContain(SUB);
  });

  test("the Clock decides: a token fresh now is stale once the Clock moves 301 s", async () => {
    await start();
    const authTime = nowS();
    expect((await get("fresh", { auth_time: authTime })).statusCode).toBe(200);
    nowMs += 300_000;
    expect((await get("fresh", { auth_time: authTime })).statusCode).toBe(200);
    nowMs += 1_000;
    expectReauth(await get("fresh", { auth_time: authTime }));
  });

  test("iat never stands in for auth_time: a refreshed token (new iat, old auth_time) is not fresh", async () => {
    await start();
    expectReauth(
      await get("fresh", { iat: nowS(), auth_time: nowS() - 3_600 }),
    );
    expectReauth(await get("fresh", { iat: nowS() }));
  });
});
