// Organisations end to end (P6-02, ADR 0072), against Postgres with the
// production journal and the directory journal, as bricx_app and
// directory_writer through the real app, the real AuthGuard (tokens from
// the local issuer) and the production DbGrantsSource. Proves the task
// plan's Done-whens and the owner's conditions:
// - POST /v1/organizations (@SignedIn, D11): any signed-in user, with no
//   org_id claim, creates an organisation in this cell (data_region =
//   CELL_ID, D2): the row, the thirteen roles, the owner membership, the
//   outbox row and two audit events (bootstrap, then create), the
//   directory reservation, the attempt committed; units default to the
//   country's (D8);
// - Idempotency-Key (C2, D12): missing 400, malformed 400, the same key
//   and body replay the stored outcome (the org, 201; a refusal, the same
//   409), the same key with another body is 422; the whole body is
//   validated before anything is written;
// - a reserved slug and a taken slug answer the same 409
//   organization.slug_unavailable (D14, R5);
// - the cap (D1, D13): ORGS_MAX_CREATED_PER_USER counts pending and
//   committed attempts, archived organisations included; parallel creates
//   never pass it;
// - R4: a directory outage leaves the attempt pending (503); the retry
//   with the same key creates the organisation with the same id;
// - without DIRECTORY_WRITER_DATABASE_URL, create is 503 and writes
//   nothing (D3);
// - GET /current (@AllowArchivedOrg), PATCH /current, POST
//   /current/archive (org.organization.archive, owner only, C3): an
//   archived organisation is 404 on every other route (D6/D16); an empty
//   PATCH body, or none, is 422 and writes nothing (P6-03, C1);
// - C1: every other route keeps the P5-02 contract: no org_id claim and
//   no X-Org-Id is 403 and writes no users row; X-Org-Id is accepted when
//   the claim is missing; a malformed claim stays 403.
import { loadApiConfig } from "@bricx/config/api";
import {
  type BootstrappedPostgres,
  appDatabase,
  directoryDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { ensureDevCells } from "@bricx/db/dev-cells";
import { migrate, migrateDirectory } from "@bricx/db/migrate";
import { ROLE_IDS } from "@bricx/permissions/roles";
import { ErrorEnvelopeSchema } from "@bricx/validation/error-envelope";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../../src/app.js";
import { ORG_ID_HEADER } from "../../src/common/auth/auth.guard.js";
import { Organization } from "../../src/modules/organizations/organizations.dto.js";
import { apiEnv } from "../env.js";
import { fakeProbes } from "../probes.js";
import {
  TestIssuer,
  applyAccess,
  bearer,
  fixedRevocations,
} from "../support/auth.js";
import { memoryRateLimits } from "../support/rate-limit.js";

const HOOK_MS = 300_000;
const CELL = "af-south-1";
const CAP = 2;

let pg18: BootstrappedPostgres;
let issuer: TestIssuer;
/** CELL_ID af-south-1, the directory writer, ORGS_MAX_CREATED_PER_USER=2. */
let app: NestFastifyApplication;
/** No DIRECTORY_WRITER_DATABASE_URL (D3). */
let noWriter: NestFastifyApplication;
/** A writer URL nothing listens on: the directory is down (R4). */
let directoryDown: NestFastifyApplication;

const host = () =>
  `${pg18.container.getHost()}:${String(pg18.container.getMappedPort(5432))}`;
const appUrl = (role: string, key: string) =>
  `postgres://${role}:${exampleValue(key)}@${host()}/${appDatabase}`;
const directoryUrl = (role: string, key: string) =>
  `postgres://${role}:${exampleValue(key)}@${host()}/${directoryDatabase}`;

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

async function inDirectory<R extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  const owner = await pg18.connectAs("directory_owner", directoryDatabase);
  try {
    return (await owner.query<R>(text, params)).rows;
  } finally {
    await owner.end();
  }
}

beforeAll(async () => {
  [pg18, issuer] = await Promise.all([startPostgres(), TestIssuer.start()]);
  await migrate({
    reveal: () => appUrl("bricx_owner", "BRICX_OWNER_PASSWORD"),
  });
  const owner = {
    reveal: () => directoryUrl("directory_owner", "DIRECTORY_OWNER_PASSWORD"),
  };
  await migrateDirectory(owner);
  await ensureDevCells(owner);
  const base = {
    ...issuer.env(),
    DATABASE_URL: appUrl("bricx_app", "BRICX_APP_PASSWORD"),
    CELL_ID: CELL,
    ORGS_MAX_CREATED_PER_USER: String(CAP),
  };
  const options = {
    probes: fakeProbes(),
    revocationStore: fixedRevocations(),
    rateLimitStore: memoryRateLimits(),
  };
  app = await createApp(
    loadApiConfig(
      apiEnv({
        ...base,
        DIRECTORY_WRITER_DATABASE_URL: directoryUrl(
          "directory_writer",
          "DIRECTORY_WRITER_PASSWORD",
        ),
      }),
    ),
    options,
  );
  await app.init();
  noWriter = await createApp(loadApiConfig(apiEnv(base)), options);
  await noWriter.init();
  directoryDown = await createApp(
    loadApiConfig(
      apiEnv({
        ...base,
        DIRECTORY_WRITER_DATABASE_URL: `postgres://directory_writer:${exampleValue("DIRECTORY_WRITER_PASSWORD")}@127.0.0.1:1/${directoryDatabase}`,
      }),
    ),
    options,
  );
  await directoryDown.init();
}, HOOK_MS);
afterAll(async () => {
  await app.close().catch(() => undefined);
  await noWriter.close().catch(() => undefined);
  await directoryDown.close().catch(() => undefined);
  await issuer.close();
  await pg18.container.stop();
}, HOOK_MS);

let counter = 0;
const next = () => {
  counter += 1;
  return counter;
};
/** A fresh subject: a user nobody has seen. */
const newSub = () => `orgs-user-${String(next())}`;
/** A fresh, valid slug. */
const newSlug = () => `acme-${String(next())}`;
/** A fresh Idempotency-Key. */
const newKey = () => `orgs-key-${String(next()).padStart(8, "0")}`;

type Res = Awaited<ReturnType<NestFastifyApplication["inject"]>>;

interface Caller {
  readonly sub: string;
  /** The org_id claim; undefined drops it (a new user's token). */
  readonly orgClaim?: unknown;
  /** X-Org-Id. */
  readonly org?: string;
  /** The acr claim (mfa unless a test says otherwise). */
  readonly acr?: string;
}

async function headersOf(who: Caller): Promise<Record<string, string>> {
  const token = await issuer.token({
    sub: who.sub,
    org_id: who.orgClaim,
    // P6-05e (ADR 0081): admin keys need acr mfa, so the fixture signs mfa
    // unless a test passes acr (the pwd step-up case below).
    acr: who.acr ?? "mfa",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  });
  return {
    ...bearer(token),
    ...(who.org === undefined ? {} : { [ORG_ID_HEADER]: who.org }),
  };
}

async function call(
  who: Caller,
  method: "GET" | "POST" | "PATCH",
  url: string,
  options: {
    readonly body?: unknown;
    readonly key?: string;
    readonly target?: NestFastifyApplication;
  } = {},
): Promise<Res> {
  return (options.target ?? app).inject({
    method,
    url,
    headers: {
      ...(await headersOf(who)),
      ...(options.key === undefined ? {} : { "idempotency-key": options.key }),
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(options.body === undefined
      ? {}
      : { payload: JSON.stringify(options.body) }),
  });
}

function expectProblem(res: Res, status: number, code: string) {
  expect(res.statusCode, res.body).toBe(status);
  const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(res.body));
  expect(parsed.success).toBe(true);
  expect(parsed.data).toMatchObject({ status, code, key: `errors:${code}` });
}

/** The problem body without the per-request trace id. */
function problemOf(res: Res): Record<string, unknown> {
  const body = JSON.parse(res.body) as Record<string, unknown>;
  Reflect.deleteProperty(body, "traceId");
  return body;
}

const bodyOf = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug,
  legalName: "Acme Construction Ltd",
  country: "SL",
  defaultCurrency: "SLE",
  defaultLanguage: "en",
  timezone: "Africa/Freetown",
  ...extra,
});

async function create(
  who: Caller,
  body: Record<string, unknown>,
  key = newKey(),
  target: NestFastifyApplication = app,
): Promise<Res> {
  return call(who, "POST", "/v1/organizations", { body, key, target });
}

async function created(who: Caller, slug = newSlug(), extra = {}) {
  const res = await create(who, bodyOf(slug, extra));
  expect(res.statusCode, res.body).toBe(201);
  return Organization.schema.parse(JSON.parse(res.body));
}

const userIdOf = async (sub: string): Promise<string | undefined> =>
  (
    await asAdmin<{ id: string }>(
      "SELECT id::text FROM bricx.users WHERE keycloak_sub = $1",
      [sub],
    )
  )[0]?.id;

const attemptsOf = (sub: string) =>
  asAdmin<{ org_id: string; slug: string; state: string }>(
    `SELECT a.org_id::text, a.slug, a.state FROM bricx.org_create_attempts a
     JOIN bricx.users u ON u.id = a.user_id WHERE u.keycloak_sub = $1
     ORDER BY a.created_at, a.org_id`,
    [sub],
  );

describe("POST /v1/organizations creates an organisation (D1, D2, D8, D11)", () => {
  test("a signed-in user with no org_id claim: 201, every row, the reservation, the attempt committed", async () => {
    const sub = newSub();
    const slug = newSlug();
    const res = await create({ sub }, bodyOf(slug, { brandColor: "#1a2b3c" }));
    expect(res.statusCode, res.body).toBe(201);
    const org = Organization.schema.parse(JSON.parse(res.body));
    expect(org).toMatchObject({
      slug,
      legalName: "Acme Construction Ltd",
      country: "SL",
      defaultCurrency: "SLE",
      defaultLanguage: "en",
      timezone: "Africa/Freetown",
      units: "metric",
      dataRegion: CELL,
      brandColor: "#1a2b3c",
      logoObjectKey: null,
      archivedAt: null,
    });
    expect(org.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(org.updatedAt).toBe(org.createdAt);
    const userId = await userIdOf(sub);
    expect(userId).toBeDefined();
    const roles = await asAdmin<{ key: string }>(
      "SELECT key FROM bricx.roles WHERE org_id = $1 ORDER BY key",
      [org.id],
    );
    expect(roles.map((r) => r.key)).toEqual([...ROLE_IDS].sort());
    const members = await asAdmin<{ user_id: string; key: string }>(
      `SELECT m.user_id::text, r.key FROM bricx.memberships m
       JOIN bricx.roles r ON r.org_id = m.org_id AND r.id = m.role_id
       WHERE m.org_id = $1`,
      [org.id],
    );
    expect(members).toEqual([{ user_id: userId, key: "owner" }]);
    expect(
      await asAdmin(
        "SELECT topic FROM bricx.outbox WHERE org_id = $1 ORDER BY id",
        [org.id],
      ),
    ).toEqual([{ topic: "users.mfa_check" }]);
    const events = await asAdmin<{
      seq: string;
      action: string;
      actor_id: string;
    }>(
      "SELECT seq::text, action, actor_id::text FROM bricx.audit_events WHERE org_id = $1 ORDER BY seq",
      [org.id],
    );
    expect(events).toEqual([
      { seq: "1", action: "org.member.bootstrap", actor_id: userId },
      { seq: "2", action: "org.organization.create", actor_id: userId },
    ]);
    expect(
      await inDirectory(
        "SELECT org_id::text, org_slug, cell_id FROM directory.org_directory WHERE org_id = $1",
        [org.id],
      ),
    ).toEqual([{ org_id: org.id, org_slug: slug, cell_id: CELL }]);
    expect(await attemptsOf(sub)).toEqual([
      { org_id: org.id, slug, state: "committed" },
    ]);
  });

  test("units default to the country's (CLDR, @bricx/domain); an explicit value wins", async () => {
    const sub = newSub();
    expect(
      (
        await created({ sub }, newSlug(), {
          country: "US",
          defaultCurrency: "USD",
          timezone: "America/New_York",
        })
      ).units,
    ).toBe("us_customary");
    expect(
      (
        await created({ sub }, newSlug(), {
          country: "US",
          defaultCurrency: "USD",
          timezone: "America/New_York",
          units: "metric",
        })
      ).units,
    ).toBe("metric");
  });

  test("the creator reads it with X-Org-Id and no org_id claim (C1, D11)", async () => {
    const sub = newSub();
    const org = await created({ sub });
    const res = await call(
      { sub, org: org.id },
      "GET",
      "/v1/organizations/current",
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(Organization.schema.parse(JSON.parse(res.body))).toEqual(org);
  });

  test("a malformed org_id claim does not stop the create route (no org is read there)", async () => {
    const res = await create(
      { sub: newSub(), orgClaim: "not-a-uuid" },
      bodyOf(newSlug()),
    );
    expect(res.statusCode, res.body).toBe(201);
  });
});

describe("the request is checked before anything is written (C2)", () => {
  test("no Idempotency-Key: 400 idempotency.key_missing; a malformed one: 400 idempotency.key_invalid; no users row, no attempt", async () => {
    const sub = newSub();
    const missing = await call({ sub }, "POST", "/v1/organizations", {
      body: bodyOf(newSlug()),
    });
    expectProblem(missing, 400, "idempotency.key_missing");
    expectProblem(
      await create({ sub }, bodyOf(newSlug()), "bad key with spaces"),
      400,
      "idempotency.key_invalid",
    );
    expect(await attemptsOf(sub)).toEqual([]);
  });

  test.each([
    ["an unknown field", { dataRegion: "eu-west-1" }],
    ["a bad slug", { slug: "-acme" }],
    ["a slug with capitals", { slug: "Acme" }],
    ["an unknown country", { country: "XX" }],
    ["an unknown currency", { defaultCurrency: "ABC" }],
    ["an unsupported language", { defaultLanguage: "de" }],
    ["an unknown time zone", { timezone: "Mars/Olympus" }],
    ["an unknown unit system", { units: "imperial" }],
    ["an upper-case brand colour", { brandColor: "#ABCDEF" }],
    ["an empty legal name", { legalName: "" }],
    ["a 201-character legal name", { legalName: "x".repeat(201) }],
  ])("%s: 422 validation_failed, no attempt", async (_what, extra) => {
    const sub = newSub();
    const res = await create({ sub }, { ...bodyOf(newSlug()), ...extra });
    expectProblem(res, 422, "validation_failed");
    expect(await attemptsOf(sub)).toEqual([]);
  });
});

describe("the same key and body replay the stored outcome (C2, D12)", () => {
  test("committed: the same org with 201, nothing written twice", async () => {
    const sub = newSub();
    const key = newKey();
    const body = bodyOf(newSlug());
    const first = await create({ sub }, body, key);
    expect(first.statusCode, first.body).toBe(201);
    const org = Organization.schema.parse(JSON.parse(first.body));
    const again = await create({ sub }, body, key);
    expect(again.statusCode, again.body).toBe(201);
    expect(Organization.schema.parse(JSON.parse(again.body))).toEqual(org);
    expect(await attemptsOf(sub)).toHaveLength(1);
    expect(
      await asAdmin(
        "SELECT count(*)::int AS n FROM bricx.audit_events WHERE org_id = $1",
        [org.id],
      ),
    ).toEqual([{ n: 2 }]);
  });

  test("the same key with another body: 422 idempotency.key_reused, nothing written", async () => {
    const sub = newSub();
    const key = newKey();
    expect((await create({ sub }, bodyOf(newSlug()), key)).statusCode).toBe(
      201,
    );
    expectProblem(
      await create({ sub }, bodyOf(newSlug()), key),
      422,
      "idempotency.key_reused",
    );
    expect(await attemptsOf(sub)).toHaveLength(1);
  });

  test("another user's key is their own: the same key text creates a second organisation", async () => {
    const key = newKey();
    expect(
      (await create({ sub: newSub() }, bodyOf(newSlug()), key)).statusCode,
    ).toBe(201);
    expect(
      (await create({ sub: newSub() }, bodyOf(newSlug()), key)).statusCode,
    ).toBe(201);
  });
});

describe("a reserved slug and a taken slug answer the same 409 (D14, R5)", () => {
  test("reserved: 409 organization.slug_unavailable, no attempt, no reservation", async () => {
    const sub = newSub();
    const res = await create({ sub }, bodyOf("www"));
    expectProblem(res, 409, "organization.slug_unavailable");
    expect(await attemptsOf(sub)).toEqual([]);
    expect(
      await inDirectory(
        "SELECT org_slug FROM directory.org_directory WHERE org_slug = 'www'",
      ),
    ).toEqual([]);
  });

  test("taken by another organisation: the same body; the attempt is refused, replays the 409 and does not count toward the cap", async () => {
    const slug = newSlug();
    await created({ sub: newSub() }, slug);
    const sub = newSub();
    const key = newKey();
    const taken = await create({ sub }, bodyOf(slug), key);
    expectProblem(taken, 409, "organization.slug_unavailable");
    const reserved = await create({ sub }, bodyOf("admin"));
    expect(problemOf(taken)).toEqual(problemOf(reserved));
    expect(await attemptsOf(sub)).toEqual([
      { org_id: expect.any(String) as string, slug, state: "refused" },
    ]);
    const replay = await create({ sub }, bodyOf(slug), key);
    expect(problemOf(replay)).toEqual(problemOf(taken));
    // Refused attempts are not counted: CAP organisations still fit.
    for (let i = 0; i < CAP; i += 1) await created({ sub });
  });
});

describe("the per-user cap (D1, D13)", () => {
  test("the next create past ORGS_MAX_CREATED_PER_USER is 409 request.conflict; an archived organisation still counts", async () => {
    const sub = newSub();
    const first = await created({ sub });
    await created({ sub });
    expectProblem(
      await create({ sub }, bodyOf(newSlug())),
      409,
      "request.conflict",
    );
    const archived = await call(
      { sub, org: first.id },
      "POST",
      "/v1/organizations/current/archive",
    );
    expect(archived.statusCode, archived.body).toBe(200);
    expectProblem(
      await create({ sub }, bodyOf(newSlug())),
      409,
      "request.conflict",
    );
  });

  test("parallel creates with different keys never pass the cap", async () => {
    const sub = newSub();
    // Provision the user first, so the parallel requests race on the cap only.
    expectProblem(
      await create({ sub }, bodyOf("support")),
      409,
      "organization.slug_unavailable",
    );
    const results = await Promise.all(
      Array.from({ length: 5 }, () => create({ sub }, bodyOf(newSlug()))),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([
      201, 201, 409, 409, 409,
    ]);
    for (const res of results.filter((r) => r.statusCode === 409)) {
      expectProblem(res, 409, "request.conflict");
    }
    expect(
      (await attemptsOf(sub)).filter((a) => a.state === "committed"),
    ).toHaveLength(CAP);
  });
});

describe("the organisation id is stable across retries (R4)", () => {
  test("the directory down: 503, the attempt stays pending; the retry with the same key creates the organisation with that id", async () => {
    const sub = newSub();
    const key = newKey();
    const slug = newSlug();
    const down = await create({ sub }, bodyOf(slug), key, directoryDown);
    expectProblem(down, 503, "server_unavailable");
    const [pending] = await attemptsOf(sub);
    expect(pending).toMatchObject({ slug, state: "pending" });
    expect(
      await asAdmin("SELECT id FROM bricx.organizations WHERE slug = $1", [
        slug,
      ]),
    ).toEqual([]);
    // A pending attempt counts toward the cap (C2 residual risk).
    const again = await create({ sub }, bodyOf(slug), key);
    expect(again.statusCode, again.body).toBe(201);
    expect(Organization.schema.parse(JSON.parse(again.body)).id).toBe(
      pending?.org_id,
    );
    expect(await attemptsOf(sub)).toEqual([
      { org_id: pending?.org_id, slug, state: "committed" },
    ]);
  });

  test("the cell transaction fails after the reservation: nothing in the cell; the retry with the same key reuses the reservation (existing) and creates one organisation with that id", async () => {
    const sub = newSub();
    const key = newKey();
    const slug = newSlug();
    // A cell row holding the slug (not in the directory) makes Tx B fail
    // after the reservation succeeded.
    const blocker = "0199e1a0-0000-7000-8000-0000000b10c0";
    await asAdmin(
      `INSERT INTO bricx.organizations
         (id, slug, legal_name, country, default_currency, default_language,
          timezone, units, data_region, created_at, updated_at)
       VALUES ($1, $2, 'Blocker Ltd', 'SL', 'SLE', 'en', 'Africa/Freetown',
          'metric', $3, now(), now())`,
      [blocker, slug, CELL],
    );
    const failed = await create({ sub }, bodyOf(slug), key);
    expect(failed.statusCode, failed.body).toBeGreaterThanOrEqual(400);
    const [pending] = await attemptsOf(sub);
    expect(pending).toMatchObject({ slug, state: "pending" });
    const reserved = await inDirectory<{ org_id: string }>(
      "SELECT org_id::text FROM directory.org_directory WHERE org_slug = $1",
      [slug],
    );
    expect(reserved).toEqual([{ org_id: pending?.org_id }]);
    expect(
      await asAdmin("SELECT id FROM bricx.organizations WHERE id = $1", [
        pending?.org_id,
      ]),
    ).toEqual([]);
    await asAdmin("DELETE FROM bricx.organizations WHERE id = $1", [blocker]);
    const retry = await create({ sub }, bodyOf(slug), key);
    expect(retry.statusCode, retry.body).toBe(201);
    expect(Organization.schema.parse(JSON.parse(retry.body)).id).toBe(
      pending?.org_id,
    );
    expect(
      await inDirectory(
        "SELECT org_id::text FROM directory.org_directory WHERE org_slug = $1",
        [slug],
      ),
    ).toEqual(reserved);
    expect(
      await asAdmin<{ n: string }>(
        "SELECT count(*)::text AS n FROM bricx.organizations WHERE slug = $1",
        [slug],
      ),
    ).toEqual([{ n: "1" }]);
    expect(await attemptsOf(sub)).toEqual([
      { org_id: pending?.org_id, slug, state: "committed" },
    ]);
  });

  test("without DIRECTORY_WRITER_DATABASE_URL: 503 server_unavailable and no attempt (D3)", async () => {
    const sub = newSub();
    const res = await create({ sub }, bodyOf(newSlug()), newKey(), noWriter);
    expectProblem(res, 503, "server_unavailable");
    expect(await attemptsOf(sub)).toEqual([]);
  });
});

describe("the current organisation (D5, D6/D16, C3)", () => {
  test("PATCH /current: the owner changes the editable fields, one org.organization.update event; the slug is not a field", async () => {
    const sub = newSub();
    const org = await created({ sub });
    const res = await call(
      { sub, org: org.id },
      "PATCH",
      "/v1/organizations/current",
      {
        body: {
          legalName: "Acme Holdings",
          brandColor: null,
          units: "us_customary",
        },
      },
    );
    expect(res.statusCode, res.body).toBe(200);
    const updated = Organization.schema.parse(JSON.parse(res.body));
    expect(updated).toMatchObject({
      ...org,
      legalName: "Acme Holdings",
      brandColor: null,
      units: "us_customary",
      updatedAt: expect.any(String) as string,
    });
    expect(
      await asAdmin(
        "SELECT action FROM bricx.audit_events WHERE org_id = $1 ORDER BY seq DESC LIMIT 1",
        [org.id],
      ),
    ).toEqual([{ action: "org.organization.update" }]);
    expectProblem(
      await call({ sub, org: org.id }, "PATCH", "/v1/organizations/current", {
        body: { slug: "renamed" },
      }),
      422,
      "validation_failed",
    );
    expectProblem(
      await call({ sub, org: org.id }, "PATCH", "/v1/organizations/current", {
        body: {},
      }),
      422,
      "validation_failed",
    );
  });

  // P6-03 (ADR 0073, owner condition C1): an empty PATCH body, or none at
  // all, is 422 validation_failed and writes nothing: no updated_at move
  // and no audit event.
  test("PATCH /current with an empty body or no body: 422 validation_failed, nothing written (P6-03, C1)", async () => {
    const sub = newSub();
    const org = await created({ sub });
    const state = () =>
      asAdmin(
        `SELECT o.updated_at::text AS updated, (SELECT count(*)::int FROM bricx.audit_events a WHERE a.org_id = o.id) AS events
         FROM bricx.organizations o WHERE o.id = $1`,
        [org.id],
      );
    const before = await state();
    for (const options of [{ body: {} }, {}]) {
      expectProblem(
        await call(
          { sub, org: org.id },
          "PATCH",
          "/v1/organizations/current",
          options,
        ),
        422,
        "validation_failed",
      );
    }
    expect(await state()).toEqual(before);
  });

  test("archive: owner only (org.organization.archive); then 404 everywhere but GET /current", async () => {
    const sub = newSub();
    const org = await created({ sub });
    const managerSub = newSub();
    // The manager's users row, then a project_manager membership.
    await call(
      { sub: managerSub, org: org.id },
      "GET",
      "/v1/organizations/current",
    );
    const managerId = await userIdOf(managerSub);
    if (managerId === undefined) throw new Error("no manager row");
    await applyAccess(asAdmin, {
      orgId: org.id,
      userId: managerId,
      role: "project_manager",
    });
    expectProblem(
      await call(
        { sub: managerSub, org: org.id },
        "POST",
        "/v1/organizations/current/archive",
      ),
      403,
      "forbidden",
    );
    const res = await call(
      { sub, org: org.id },
      "POST",
      "/v1/organizations/current/archive",
    );
    expect(res.statusCode, res.body).toBe(200);
    const archived = Organization.schema.parse(JSON.parse(res.body));
    expect(archived.archivedAt).not.toBeNull();
    expect(
      await asAdmin(
        "SELECT action FROM bricx.audit_events WHERE org_id = $1 ORDER BY seq DESC LIMIT 1",
        [org.id],
      ),
    ).toEqual([{ action: "org.organization.archive" }]);
    const current = await call(
      { sub, org: org.id },
      "GET",
      "/v1/organizations/current",
    );
    expect(current.statusCode, current.body).toBe(200);
    expect(Organization.schema.parse(JSON.parse(current.body))).toEqual(
      archived,
    );
    expectProblem(
      await call({ sub, org: org.id }, "PATCH", "/v1/organizations/current", {
        body: { legalName: "Revived" },
      }),
      404,
      "not_found",
    );
    expectProblem(
      await call(
        { sub, org: org.id },
        "POST",
        "/v1/organizations/current/archive",
      ),
      404,
      "not_found",
    );
    expectProblem(
      await call({ sub, org: org.id }, "GET", "/v1/members"),
      404,
      "not_found",
    );
    // The slug stays reserved in the directory (D6).
    expect(
      await inDirectory(
        "SELECT org_slug FROM directory.org_directory WHERE org_id = $1",
        [org.id],
      ),
    ).toEqual([{ org_slug: org.slug }]);
  });
});

describe("every other route keeps the P5-02 contract (C1)", () => {
  test("no org_id claim and no X-Org-Id: 403 forbidden and no users row", async () => {
    const sub = newSub();
    for (const [method, url] of [
      ["GET", "/v1/organizations/current"],
      ["GET", "/v1/members"],
      ["GET", "/v1/sessions"],
    ] as const) {
      expectProblem(await call({ sub }, method, url), 403, "forbidden");
    }
    expect(await userIdOf(sub)).toBeUndefined();
  });

  test("a malformed org_id claim stays 403, with or without X-Org-Id, and writes no users row", async () => {
    const org = await created({ sub: newSub() });
    const other = newSub();
    for (const who of [
      { sub: other, orgClaim: "not-a-uuid" },
      { sub: other, orgClaim: "not-a-uuid", org: org.id },
      { sub: other, orgClaim: 42, org: org.id },
    ]) {
      expectProblem(
        await call(who, "GET", "/v1/organizations/current"),
        403,
        "forbidden",
      );
    }
    expect(await userIdOf(other)).toBeUndefined();
  });

  test("X-Org-Id without a membership there: 403 forbidden (membership_missing)", async () => {
    const org = await created({ sub: newSub() });
    expectProblem(
      await call(
        { sub: newSub(), org: org.id },
        "GET",
        "/v1/organizations/current",
      ),
      403,
      "forbidden",
    );
  });
});

describe("an admin key at acr pwd (P6-05e, ADR 0081)", () => {
  test("PATCH /current is 401 permission.step_up_required with the RFC 9470 challenge, nothing written; the read stays 200 at pwd", async () => {
    const sub = newSub();
    const org = await created({ sub });
    const pwd = { sub, org: org.id, acr: "pwd" };
    const refused = await call(pwd, "PATCH", "/v1/organizations/current", {
      body: { legalName: "Step-up Ltd" },
    });
    expectProblem(refused, 401, "permission.step_up_required");
    expect(refused.headers["www-authenticate"]).toBe(
      'Bearer error="insufficient_user_authentication", acr_values="mfa"',
    );
    const read = await call(pwd, "GET", "/v1/organizations/current");
    expect(read.statusCode, read.body).toBe(200);
    expect(Organization.schema.parse(JSON.parse(read.body))).toEqual(org);
  });
});
