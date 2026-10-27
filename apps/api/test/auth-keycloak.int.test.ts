// P5-02 Verify, live (ADR 0062; plan section 3, owner condition 5): the
// API's AuthGuard against the real P5-01 realm, started as compose.yml
// starts it (@bricx/keycloak-realm/testing), with tokens from real
// bricx-client logins (code + PKCE). The API runs against compose.yml's
// Postgres with the production journal. Proves: a real token is accepted
// and provisions one users row; expired (the API's Clock moved past exp
// + 5 s), wrong audience (a second client without the audience mapper)
// and wrong issuer (the same realm and key reached as 127.0.0.1, so iss
// differs while the signature is valid) are 401; a user without org_id is
// 403 with no users row; key rotation (a new RS256 provider with a higher
// priority, the old one disabled) refetches the JWKS once and accepts the
// new kid. Hooks get 600 s (P5-01 condition 1).
import { Writable } from "node:stream";
import { loadApiConfig } from "@bricx/config/api";
import {
  type BootstrappedPostgres,
  appDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { migrate } from "@bricx/db/migrate";
import {
  type Keycloak,
  type RealmUser,
  claimsOf,
  createRealmUser,
  passwordLogin,
  startKeycloak,
  tokenCall,
} from "@bricx/keycloak-realm/testing";
import { isArray, isObject } from "@bricx/keycloak-realm/normalise";
import { Controller, Get } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { NoPermission } from "../src/common/auth/can.decorator.js";
import { createApp } from "../src/app.js";
import { CLOCK_TOLERANCE_SECONDS } from "../src/common/auth/token-verifier.js";
import { currentRequestContext } from "../src/common/db/request-context.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";
import { fixedRevocations, bearer, roleGrants } from "./support/auth.js";

const HOOK_MS = 600_000;
const ORG = "01920000-0000-7000-8000-0000000000a1";
const PASSWORD = "test-only-api-login-pw-1";

@NoPermission("test-only probe")
@Controller({ path: "whoami", version: "1" })
class WhoAmIController {
  @Get()
  get() {
    return { identity: currentRequestContext()?.identity ?? null };
  }
}

let keycloak: Keycloak | undefined;
let pg18: BootstrappedPostgres | undefined;
let app: NestFastifyApplication | undefined;
const lines: string[] = [];
const clock = { offsetMs: 0, now: () => Date.now() + clock.offsetMs };
let jwksFetches = 0;

function kc(): Keycloak {
  if (keycloak === undefined) throw new Error("Keycloak did not start");
  return keycloak;
}
function api(): NestFastifyApplication {
  if (app === undefined) throw new Error("the API did not start");
  return app;
}

async function asAdmin<R extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  if (pg18 === undefined) throw new Error("Postgres did not start");
  const admin = await pg18.admin();
  try {
    return (await admin.query(text, params)).rows as R[];
  } finally {
    await admin.end();
  }
}

const usersFor = (sub: string) =>
  asAdmin<{ id: string }>(
    "SELECT id::text FROM bricx.users WHERE keycloak_sub = $1",
    [sub],
  );

beforeAll(async () => {
  [keycloak, pg18] = await Promise.all([startKeycloak(), startPostgres()]);
  const pg = pg18;
  const urlFor = (role: string, key: string) =>
    `postgres://${role}:${exampleValue(key)}@${pg.container.getHost()}:${String(pg.container.getMappedPort(5432))}/${appDatabase}`;
  await migrate({
    reveal: () => urlFor("bricx_owner", "BRICX_OWNER_PASSWORD"),
  });
  app = await createApp(
    loadApiConfig(
      apiEnv({
        KEYCLOAK_ISSUER: `${keycloak.base}/realms/bricx`,
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
      grantsSource: roleGrants(),
      clock,
      // The rotation case needs the refetch at once (owner condition 5).
      jwks: {
        cooldownMs: 0,
        fetch: (url, init) => {
          jwksFetches += 1;
          return fetch(url, init);
        },
      },
    },
  );
  await app.init();
}, HOOK_MS);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await keycloak?.container.stop();
  await pg18?.container.stop();
}, HOOK_MS);

const whoami = (token: string) =>
  api().inject({ method: "GET", url: "/v1/whoami", headers: bearer(token) });

const reasons = () =>
  lines
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.msg === "auth.failed")
    .map((l) => l.reason);

let userCounter = 0;
/** A password-only realm user; `null` leaves org_id unset. */
async function newUser(orgId: string | null = ORG): Promise<{
  user: RealmUser;
  sub: string;
}> {
  userCounter += 1;
  const user = {
    username: `api-user-${String(userCounter)}`,
    password: PASSWORD,
    orgId: orgId ?? undefined,
  };
  return { user, sub: await createRealmUser(kc(), user) };
}

function expect401(res: {
  statusCode: number;
  headers: Record<string, unknown>;
  json: () => unknown;
}) {
  expect(res.statusCode).toBe(401);
  expect(res.headers["www-authenticate"]).toBe("Bearer");
  expect(res.json()).toMatchObject({ status: 401, code: "unauthenticated" });
}

describe("real tokens from the P5-01 realm", () => {
  test("a bricx-client token is accepted: one users row for its sub, the org from org_id", async () => {
    const { user, sub } = await newUser();
    const { access_token: token } = await passwordLogin(kc(), user);
    const claims = claimsOf(token);
    expect(claims).toMatchObject({ sub, typ: "Bearer", org_id: ORG });
    const res = await whoami(token);
    expect(res.statusCode).toBe(200);
    const rows = await usersFor(sub);
    expect(rows).toHaveLength(1);
    expect(res.json()).toMatchObject({
      identity: { orgId: ORG, userId: rows[0]?.id, projectIds: [] },
    });
    expect((await whoami(token)).statusCode).toBe(200);
    expect(await usersFor(sub)).toHaveLength(1);
    // P5-03 (ADR 0063): a real token's sid makes exactly one sessions row
    // for the user and org, reused by the second request.
    expect(typeof claims.sid).toBe("string");
    expect(
      await asAdmin(
        "SELECT org_id::text AS org, keycloak_sid AS sid, device_id FROM bricx.sessions WHERE user_id = $1",
        [rows[0]?.id],
      ),
    ).toEqual([{ org: ORG, sid: claims.sid, device_id: null }]);
  });

  test("expired: the API's Clock past exp + 5 s gives 401, reason expired", async () => {
    const { user } = await newUser();
    const { access_token: token } = await passwordLogin(kc(), user);
    const exp = Number(claimsOf(token).exp);
    const before = reasons().length;
    clock.offsetMs = (exp + CLOCK_TOLERANCE_SECONDS + 2) * 1000 - Date.now();
    try {
      expect401(await whoami(token));
    } finally {
      clock.offsetMs = 0;
    }
    expect(reasons().slice(before)).toEqual(["expired"]);
  });

  test("wrong audience: a second client without the audience mapper gives 401, reason audience_mismatch", async () => {
    await kc().admin("POST", "/clients", {
      clientId: "p5-02-no-audience",
      enabled: true,
      publicClient: true,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: true,
      fullScopeAllowed: false,
      defaultClientScopes: ["basic", "bricx-org"],
      optionalClientScopes: [],
    });
    const { user } = await newUser();
    const { access_token: token } = await tokenCall(kc(), kc().base, {
      grant_type: "password",
      client_id: "p5-02-no-audience",
      username: user.username,
      password: user.password,
      scope: "openid",
    });
    const aud = claimsOf(token).aud;
    expect(
      aud === "bricx-api" || (Array.isArray(aud) && aud.includes("bricx-api")),
    ).toBe(false);
    const before = reasons().length;
    expect401(await whoami(token));
    expect(reasons().slice(before)).toEqual(["audience_mismatch"]);
  });

  test("wrong issuer: the same realm and key reached as 127.0.0.1 gives 401, reason issuer_mismatch", async () => {
    const { user } = await newUser();
    const other = kc().base.replace("://localhost:", "://127.0.0.1:");
    expect(other).not.toBe(kc().base);
    const { access_token: token } = await passwordLogin(kc(), user, other);
    expect(claimsOf(token).iss).toBe(`${other}/realms/bricx`);
    const before = reasons().length;
    expect401(await whoami(token));
    expect(reasons().slice(before)).toEqual(["issuer_mismatch"]);
  });

  test("a user without org_id: 403, reason org_missing, no users row", async () => {
    const { user, sub } = await newUser(null);
    const { access_token: token } = await passwordLogin(kc(), user);
    expect(claimsOf(token).org_id).toBeUndefined();
    const before = reasons().length;
    const res = await whoami(token);
    expect(res.statusCode).toBe(403);
    expect(reasons().slice(before)).toEqual(["org_missing"]);
    expect(await usersFor(sub)).toEqual([]);
  });

  test("rotation: a new RS256 key with a higher priority and the old one disabled; one JWKS refetch, the new kid is accepted, the old one refused", async () => {
    const { user } = await newUser();
    const { access_token: oldToken } = await passwordLogin(kc(), user);
    expect((await whoami(oldToken)).statusCode).toBe(200);
    const realm = await kc().admin("GET", "");
    const realmId = isObject(realm) ? realm.id : undefined;
    const components = await kc().admin(
      "GET",
      "/components?type=org.keycloak.keys.KeyProvider",
    );
    const providers = isArray(components) ? components : [];
    const oldRsa = providers.filter(
      (c) => isObject(c) && c.providerId === "rsa-generated",
    );
    expect(oldRsa.length).toBeGreaterThan(0);
    await kc().admin("POST", "/components", {
      name: "p5-02-rotated",
      providerId: "rsa-generated",
      providerType: "org.keycloak.keys.KeyProvider",
      parentId: realmId ?? null,
      config: {
        priority: ["1000"],
        keySize: ["2048"],
        algorithm: ["RS256"],
        active: ["true"],
        enabled: ["true"],
      },
    });
    for (const provider of oldRsa) {
      if (!isObject(provider)) continue;
      const config = provider.config;
      const id = provider.id;
      if (typeof id !== "string")
        throw new Error("a key provider without an id");
      await kc().admin("PUT", `/components/${id}`, {
        ...provider,
        config: {
          ...(isObject(config) ? config : {}),
          enabled: ["false"],
          active: ["false"],
        },
      });
    }
    const { access_token: newToken } = await passwordLogin(kc(), user);
    const header = JSON.parse(
      Buffer.from(newToken.split(".")[0] ?? "", "base64url").toString("utf8"),
    ) as { kid?: string; alg?: string };
    const oldHeader = JSON.parse(
      Buffer.from(oldToken.split(".")[0] ?? "", "base64url").toString("utf8"),
    ) as { kid?: string };
    expect(header.alg).toBe("RS256");
    expect(header.kid).not.toBe(oldHeader.kid);
    const before = jwksFetches;
    expect((await whoami(newToken)).statusCode).toBe(200);
    expect(jwksFetches - before).toBe(1);
    expect((await whoami(newToken)).statusCode).toBe(200);
    expect(jwksFetches - before).toBe(1);
    const failedBefore = reasons().length;
    expect401(await whoami(oldToken));
    expect(reasons().slice(failedBefore)).toEqual(["key_unknown"]);
  });
});
