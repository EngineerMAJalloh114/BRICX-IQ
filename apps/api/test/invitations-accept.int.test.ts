// P6-06 accept against the REAL cell Keycloak's userinfo (ADR 0077, D6,
// D7; owner condition C3), live: the realm as compose.yml starts it,
// tokens from real bricx-client logins (code + PKCE), the API's own
// userinfo client (its URL from KEYCLOAK_ISSUER only), on compose.yml's
// Postgres with the production journal. The invitation rows are seeded as
// the superuser in the API's INSERT shape with the hash of a known secret
// (the worker's mint is proven in apps/worker).
// - a verified address equal to the invited one joins: 200, one open
//   membership, the row accepted with its address gone;
// - another verified user with the same token: the uniform 404, the row
//   still pending;
// - no caching (C3): the invitee signs in verified, Keycloak then marks
//   the address unverified: the same access token is the uniform 404;
//   verified again: 200;
// - a token whose Keycloak session is gone (logout): userinfo refuses it,
//   so accept is 401 unauthenticated and nothing is written.
import { Writable } from "node:stream";
import { loadApiConfig } from "@bricx/config/api";
import {
  type BootstrappedPostgres,
  appDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import {
  hashInvitationSecret,
  invitationTokenOf,
  newInvitationSecret,
} from "@bricx/db/invitations";
import { migrate } from "@bricx/db/migrate";
import {
  type Keycloak,
  createRealmUser,
  passwordLogin,
  startKeycloak,
} from "@bricx/keycloak-realm/testing";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";
import {
  applyAccess,
  bearer,
  fixedRevocations,
  seedId,
  seedRole,
  seedUsers,
} from "./support/auth.js";
import { memoryRateLimits } from "./support/rate-limit.js";

const HOOK_MS = 600_000;
const ORG = "01920000-0000-7000-8000-0000000009a1";
const OWNER = "01920000-0000-7000-8000-000000000901";
const PASSWORD = "test-only-invitation-accept-pw-1";
const CELL = "af-south-1";

let keycloak: Keycloak;
let pg18: BootstrappedPostgres;
let app: NestFastifyApplication;
let role: string;
const users: Record<string, { id: string; sub: string; email: string }> = {};

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
  [keycloak, pg18] = await Promise.all([startKeycloak(), startPostgres()]);
  const urlFor = (r: string, key: string) =>
    `postgres://${r}:${exampleValue(key)}@${pg18.container.getHost()}:${String(pg18.container.getMappedPort(5432))}/${appDatabase}`;
  await migrate({
    reveal: () => urlFor("bricx_owner", "BRICX_OWNER_PASSWORD"),
  });
  await seedUsers(asAdmin, [{ id: OWNER, sub: "accept-owner-subject" }]);
  await applyAccess(asAdmin, { orgId: ORG, userId: OWNER, role: "owner" });
  role = await seedRole(asAdmin, ORG, "viewer");
  // Realm users with no org_id: accept is a signed-in route (D7).
  for (const name of [
    "accept-invitee",
    "accept-other",
    "accept-flip",
    "accept-gone",
  ]) {
    const sub = await createRealmUser(keycloak, {
      username: name,
      password: PASSWORD,
    });
    const id = seedId();
    await seedUsers(asAdmin, [{ id, sub }]);
    users[name] = { id, sub, email: `${name}@example.test` };
  }
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
      rateLimitStore: memoryRateLimits(),
      logStream: new Writable({
        write(_chunk: Buffer, _encoding, done) {
          done();
        },
      }),
    },
  );
  await app.init();
}, HOOK_MS);

afterAll(async () => {
  await app.close().catch(() => undefined);
  await keycloak.container.stop();
  await pg18.container.stop();
}, HOOK_MS);

const user = (name: string) => {
  const found = users[name];
  if (found === undefined) throw new Error(`no user ${name}`);
  return found;
};

/** A pending invitation for `email` with a known secret; returns id and token. */
async function invitation(
  email: string,
): Promise<{ id: string; token: string }> {
  const id = seedId();
  const secret = newInvitationSecret();
  await asAdmin(
    `INSERT INTO bricx.invitations
       (id, org_id, email_normalised, role_id, token_hash, expires_at,
        invited_by, created_at, updated_at, last_sent_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '72 hours', $6,
             now() - interval '1 minute', now() - interval '1 minute',
             now() - interval '1 minute')`,
    [id, ORG, email, role, hashInvitationSecret(secret), OWNER],
  );
  return { id, token: invitationTokenOf(CELL, secret) };
}

const login = async (name: string) =>
  (await passwordLogin(keycloak, { username: name, password: PASSWORD }))
    .access_token;

const accept = (accessToken: string, token: string) =>
  app.inject({
    method: "POST",
    url: "/v1/invitations/accept",
    headers: { ...bearer(accessToken), "content-type": "application/json" },
    payload: JSON.stringify({ token }),
  });

const statusOf = async (id: string) =>
  (
    await asAdmin<{ status: string; email_normalised: string | null }>(
      "SELECT status, email_normalised FROM bricx.invitations WHERE id = $1",
      [id],
    )
  )[0];

const membershipsOf = (userId: string) =>
  asAdmin(
    "SELECT 1 FROM bricx.memberships WHERE org_id = $1 AND user_id = $2 AND removed_at IS NULL",
    [ORG, userId],
  );

const setVerified = (sub: string, emailVerified: boolean) =>
  keycloak.admin("PUT", `/users/${sub}`, { emailVerified });

describe("accept over the cell's userinfo (C3)", () => {
  test("the verified invited address joins: 200, one membership, the row accepted and its address gone", async () => {
    const invitee = user("accept-invitee");
    const { id, token } = await invitation(invitee.email);
    const res = await accept(await login("accept-invitee"), token);
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ orgId: ORG, projectId: null });
    expect(await membershipsOf(invitee.id)).toHaveLength(1);
    expect(await statusOf(id)).toEqual({
      status: "accepted",
      email_normalised: null,
    });
  });

  test("another verified user with the token: the uniform 404; the row stays pending", async () => {
    const { id, token } = await invitation("someone-else@example.test");
    const res = await accept(await login("accept-other"), token);
    expect(res.statusCode, res.body).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({
      code: "invitation.unavailable",
    });
    expect(await statusOf(id)).toMatchObject({ status: "pending" });
    expect(await membershipsOf(user("accept-other").id)).toEqual([]);
  });

  test("no caching: the same access token is 404 once Keycloak marks the address unverified, and 200 once it is verified again", async () => {
    const flip = user("accept-flip");
    const { id, token } = await invitation(flip.email);
    const accessToken = await login("accept-flip");
    await setVerified(flip.sub, false);
    const refused = await accept(accessToken, token);
    expect(refused.statusCode, refused.body).toBe(404);
    expect(await statusOf(id)).toMatchObject({ status: "pending" });
    await setVerified(flip.sub, true);
    const joined = await accept(accessToken, token);
    expect(joined.statusCode, joined.body).toBe(200);
    expect(await membershipsOf(flip.id)).toHaveLength(1);
  });

  test("a token whose Keycloak session ended: userinfo refuses it, accept is 401 and writes nothing", async () => {
    const gone = user("accept-gone");
    const { id, token } = await invitation(gone.email);
    const accessToken = await login("accept-gone");
    await keycloak.admin("POST", `/users/${gone.sub}/logout`);
    const res = await accept(accessToken, token);
    expect(res.statusCode, res.body).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ code: "unauthenticated" });
    expect(await statusOf(id)).toMatchObject({ status: "pending" });
    expect(await membershipsOf(gone.id)).toEqual([]);
  });
});
