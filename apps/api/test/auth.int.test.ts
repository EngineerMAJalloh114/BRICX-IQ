// P5-02 (ADR 0062; owner conditions 2, 3 and 6, plan D3 and D8): the
// AuthGuard against compose.yml's Postgres with the production journal,
// as bricx_app, with tokens from the local test issuer. Provisioning runs
// app.provision_user inside withTx (org = the token's hint, user = a fresh
// UUIDv7 candidate): the first request inserts one users row and the
// identity's user id is that row's id; later requests reuse it; ten
// parallel first requests give one row; last_seen_at moves only once the
// configured throttle has passed (on the injected Clock). A failed token
// writes no audit_events row and no users row, and logs exactly one
// auth.failed line; a token without a valid org_id is 403 with no users
// row. Neither the sub nor the token reaches a log line.
import { Writable } from "node:stream";
import { loadApiConfig } from "@bricx/config/api";
import {
  type BootstrappedPostgres,
  appDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { migrate } from "@bricx/db/migrate";
import { Controller, Get } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { currentRequestContext } from "../src/common/db/request-context.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";
import { TestIssuer, bearer, roleGrants } from "./support/auth.js";

const HOOK_MS = 300_000;
const ORG = "0199e1a0-0000-7000-8000-00000000000a";
const THROTTLE_SECONDS = 60;
const SENTINEL = "sub-sentinel-0b7e-personal";

@Controller({ path: "whoami", version: "1" })
class WhoAmIController {
  @Get()
  get() {
    return { identity: currentRequestContext()?.identity ?? null };
  }
}

let pg18: BootstrappedPostgres;
let issuer: TestIssuer;
let app: NestFastifyApplication;
const lines: string[] = [];
const clock = { offsetMs: 0, now: () => Date.now() + clock.offsetMs };

const urlFor = (role: string, key: string) =>
  `postgres://${role}:${exampleValue(key)}@${pg18.container.getHost()}:${String(pg18.container.getMappedPort(5432))}/${appDatabase}`;

async function asAdmin<R extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  const admin = await pg18.admin();
  try {
    return (await admin.query(text, params)).rows as R[];
  } finally {
    await admin.end();
  }
}

interface UserRow extends Record<string, unknown> {
  id: string;
  created_at: string;
  last_seen_at: string;
}
const usersFor = (sub: string) =>
  asAdmin<UserRow>(
    "SELECT id::text, created_at::text, last_seen_at::text FROM bricx.users WHERE keycloak_sub = $1",
    [sub],
  );
const counts = async () =>
  (
    await asAdmin<{ users: number; audit: number }>(
      "SELECT (SELECT count(*)::int FROM bricx.users) AS users, (SELECT count(*)::int FROM bricx.audit_events) AS audit",
    )
  )[0];

beforeAll(async () => {
  [pg18, issuer] = await Promise.all([startPostgres(), TestIssuer.start()]);
  await migrate({
    reveal: () => urlFor("bricx_owner", "BRICX_OWNER_PASSWORD"),
  });
  app = await createApp(
    loadApiConfig(
      apiEnv({
        ...issuer.env(),
        DATABASE_URL: urlFor("bricx_app", "BRICX_APP_PASSWORD"),
        USERS_LAST_SEEN_THROTTLE_SECONDS: String(THROTTLE_SECONDS),
      }),
    ),
    {
      probes: fakeProbes(),
      logStream: new Writable({
        write(chunk: Buffer, _encoding, done) {
          lines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
          done();
        },
      }),
      extraControllers: [WhoAmIController],
      grantsSource: roleGrants(),
      clock,
    },
  );
  await app.init();
}, HOOK_MS);

afterAll(async () => {
  await app.close().catch(() => undefined);
  await issuer.close();
  await pg18.container.stop();
}, HOOK_MS);

const whoami = (headers: Record<string, string>) =>
  app.inject({ method: "GET", url: "/v1/whoami", headers });

const logged = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
const messages = (msg: string) => logged().filter((l) => l.msg === msg);

const identityOf = (body: string) =>
  (JSON.parse(body) as { identity: { userId: string; orgId: string } })
    .identity;

describe("provisioning (D8, owner conditions 2 and 3)", () => {
  test("the first request inserts one users row; the identity's user is that row; a second request reuses it", async () => {
    const sub = `${SENTINEL}-first`;
    const before = messages("auth.provisioned").length;
    const token = await issuer.token({ sub, org_id: ORG });
    const first = await whoami(bearer(token));
    expect(first.statusCode).toBe(200);
    const rows = await usersFor(sub);
    expect(rows).toHaveLength(1);
    expect(identityOf(first.body)).toEqual(
      expect.objectContaining({ userId: rows[0]?.id, orgId: ORG }),
    );
    const second = await whoami(bearer(token));
    expect(identityOf(second.body).userId).toBe(rows[0]?.id);
    expect(await usersFor(sub)).toHaveLength(1);
    // One provisioned line, for the insert only; no sub in it.
    const provisioned = messages("auth.provisioned").slice(before);
    expect(provisioned).toHaveLength(1);
    expect(provisioned[0]).toMatchObject({ userId: rows[0]?.id, orgId: ORG });
    expect(lines.join("\n")).not.toContain(SENTINEL);
    expect(lines.join("\n")).not.toContain(token);
  });

  test("ten parallel first requests for one sub: one row, one id", async () => {
    const sub = `${SENTINEL}-parallel`;
    const token = await issuer.token({ sub, org_id: ORG });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => whoami(bearer(token))),
    );
    for (const res of results) expect(res.statusCode).toBe(200);
    const rows = await usersFor(sub);
    expect(rows).toHaveLength(1);
    expect(new Set(results.map((r) => identityOf(r.body).userId))).toEqual(
      new Set([rows[0]?.id]),
    );
  });

  test("last_seen_at moves only after the configured throttle (injected Clock)", async () => {
    const sub = `${SENTINEL}-throttle`;
    clock.offsetMs = 0;
    const token = await issuer.token({
      sub,
      org_id: ORG,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    await whoami(bearer(token));
    const [created] = await usersFor(sub);
    clock.offsetMs = (THROTTLE_SECONDS - 10) * 1000;
    await whoami(bearer(token));
    const [inside] = await usersFor(sub);
    expect(inside?.last_seen_at).toBe(created?.last_seen_at);
    clock.offsetMs = (THROTTLE_SECONDS + 10) * 1000;
    await whoami(bearer(token));
    const [after] = await usersFor(sub);
    expect(after?.last_seen_at).not.toBe(created?.last_seen_at);
    expect(Date.parse(String(after?.last_seen_at))).toBeGreaterThan(
      Date.parse(String(created?.last_seen_at)),
    );
    expect(after?.created_at).toBe(created?.created_at);
    clock.offsetMs = 0;
  });
});

describe("failures write nothing (D3)", () => {
  test("a bad token: 401, no audit_events row, no users row, exactly one auth.failed line without the sub or the token", async () => {
    const sub = `${SENTINEL}-bad`;
    const before = await counts();
    const failedBefore = messages("auth.failed").length;
    const token = await issuer.token(
      { sub, org_id: ORG },
      { key: "unpublished", kid: issuer.kid },
    );
    const res = await whoami(bearer(token));
    expect(res.statusCode).toBe(401);
    expect(await counts()).toEqual(before);
    const failed = messages("auth.failed").slice(failedBefore);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ reason: "signature_invalid" });
    expect(lines.join("\n")).not.toContain(sub);
    expect(lines.join("\n")).not.toContain(token);
  });

  test("a valid token without org_id: 403, no users row for the sub, no audit row", async () => {
    const sub = `${SENTINEL}-no-org`;
    const before = await counts();
    const res = await whoami(bearer(await issuer.token({ sub })));
    expect(res.statusCode).toBe(403);
    expect(await usersFor(sub)).toEqual([]);
    expect(await counts()).toEqual(before);
  });
});
