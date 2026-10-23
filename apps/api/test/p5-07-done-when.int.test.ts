// P5-07 Done-when (ADR 0068; ROADMAP P5-07 DW2, DW3, DW5-DW8; owner
// decisions D-A to D-C, D2 = (a), conditions 1, 2, 5 and 6), through the
// real API, the production grants source (DbGrantsSource), the real
// migrator and the test-only fixtures in test/support (finance-fixture.ts,
// sod-fixture.ts), registered through createApp's extraControllers only.
// The app runs on a clock the tests move (tokens, elevations, the SoD
// history's created_at); every request carries its own Keycloak sid, so a
// clock jump never meets an idle session.
// - DW2: an elevated finance key passes the guard while its window is
//   open and is 403 once it has expired (DbGrantsSource, no second path).
// - DW3: the same key at acr pwd is 401 permission.step_up_required.
// - DW5: every SOD_RULES pair (derived, not counted by hand) in both
//   orders on one chain by one actor is 403 permission.sod_violation;
//   another actor, or another chain, is allowed; a rolled-back action
//   leaves no history row; two concurrent opposite sides by one actor:
//   exactly one succeeds.
// - DW6: the actor is the identity's user, never the granter of an
//   elevation; an elevation never lets a requester approve.
// - DW7 (D2 = (a)): a single-member org's request is pending
//   sod_no_approver; the owner's approval is refused (no override), and
//   still refused 30 days later; in a second org a second approver joining
//   flips the state to awaiting_approval, leaving flips it back, and the
//   approver can approve at mfa (401 at pwd).
// Every finance.* key needs acr mfa (requiresMfa), finance.payment.read
// included, so the state reads below carry acr mfa too.
// - DW8 (layers, the parts only the API shows): the history row is
//   written in the org's transaction by the app role; the rest is proven
//   in packages/db sod.int.test.ts (RLS, append-only, trigger, drift).
import { Writable } from "node:stream";
import { loadApiConfig } from "@bricx/config/api";
import {
  type BootstrappedPostgres,
  appDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { migrate } from "@bricx/db/migrate";
import { splitPermission } from "@bricx/permissions/catalogue";
import { SOD_RULES } from "@bricx/permissions/sod";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";
import {
  TestIssuer,
  applyAccess,
  bearer,
  fixedRevocations,
  seedUsers,
} from "./support/auth.js";
import { FinanceFixtureController } from "./support/finance-fixture.js";
import { SodFixtureController } from "./support/sod-fixture.js";

const HOOK_MS = 300_000;
const ORG_SOLO = "0199e1a0-0000-7000-8000-0000000007a0";
const ORG_A = "0199e1a0-0000-7000-8000-0000000007a1";
const PROJECT = "0199e1a0-0000-7000-8000-0000000007b1";
const SOLO_PROJECT = "0199e1a0-0000-7000-8000-0000000007b0";
const users = {
  solo: "0199e1a0-0000-7000-8000-0000000007e0",
  requester: "0199e1a0-0000-7000-8000-0000000007e1",
  manager: "0199e1a0-0000-7000-8000-0000000007e2",
  elevated: "0199e1a0-0000-7000-8000-0000000007e3",
  approver: "0199e1a0-0000-7000-8000-0000000007e4",
  accountant: "0199e1a0-0000-7000-8000-0000000007e5",
} as const;
const subOf = (user: string) => `p507-${user}`;
const ELEVATION = "0199e1a7-0000-7000-8000-0000000007f1";

let idCounter = 0;
/** A fresh UUIDv7 for a payment or a chain. */
const nextId = (): string => {
  idCounter += 1;
  return `0199e1a8-0000-7000-8000-${idCounter.toString(16).padStart(12, "0")}`;
};

let pg18: BootstrappedPostgres;
let issuer: TestIssuer;
let app: NestFastifyApplication;
/** The app's clock (ms since the epoch, whole seconds). */
const T0 = Math.floor(Date.now() / 1000) * 1000;
let at = T0;
const DAY = 86_400_000;

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

beforeAll(async () => {
  [pg18, issuer] = await Promise.all([startPostgres(), TestIssuer.start()]);
  issuer.nowSeconds = () => Math.floor(at / 1000);
  await migrate({
    reveal: () => urlFor("bricx_owner", "BRICX_OWNER_PASSWORD"),
  });
  await seedUsers(
    asAdmin,
    Object.values(users).map((id) => ({ id, sub: subOf(id) })),
  );
  // The single-member org: its owner alone.
  await applyAccess(asAdmin, {
    orgId: ORG_SOLO,
    userId: users.solo,
    role: "owner",
  });
  // Org A: an owner who requests, a project manager (request, no
  // approve), an accountant (no approve), a member elevated to approve on
  // PROJECT for one day. The approver joins in DW7.
  await applyAccess(asAdmin, {
    orgId: ORG_A,
    userId: users.requester,
    role: "owner",
  });
  await applyAccess(asAdmin, {
    orgId: ORG_A,
    userId: users.manager,
    role: "project_manager",
    projects: [PROJECT],
  });
  await applyAccess(asAdmin, {
    orgId: ORG_A,
    userId: users.accountant,
    role: "accountant",
  });
  await applyAccess(asAdmin, {
    orgId: ORG_A,
    userId: users.elevated,
    role: "member",
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
      clock: { now: () => at },
      logStream: new Writable({
        write(_chunk: Buffer, _encoding, done) {
          done();
        },
      }),
      extraControllers: [FinanceFixtureController, SodFixtureController],
    },
  );
  await app.init();
}, HOOK_MS);

afterAll(async () => {
  await app.close();
  await issuer.close();
  await pg18.container.stop();
}, HOOK_MS);

let sidCounter = 0;
async function send(
  method: "GET" | "POST",
  url: string,
  user: string,
  orgId: string,
  acr: string | undefined,
) {
  sidCounter += 1;
  return app.inject({
    method,
    url,
    headers: bearer(
      await issuer.token({
        sub: subOf(user),
        org_id: orgId,
        sid: `p507-sid-${String(sidCounter)}`,
        ...(acr === undefined ? {} : { acr }),
      }),
    ),
  });
}

async function act(
  user: string,
  orgId: string,
  chainId: string,
  permission: string,
  options: { fail?: boolean } = {},
) {
  const parts = splitPermission(permission);
  if (parts === undefined) throw new Error("bad permission");
  sidCounter += 1;
  return app.inject({
    method: "POST",
    url: `/v1/test-sod/chains/${chainId}/actions`,
    headers: {
      ...bearer(
        await issuer.token({
          sub: subOf(user),
          org_id: orgId,
          sid: `p507-sid-${String(sidCounter)}`,
          acr: "mfa",
        }),
      ),
      "content-type": "application/json",
    },
    payload: JSON.stringify({
      recordType: parts.subject,
      action: parts.action,
      ...(options.fail === true ? { fail: true } : {}),
    }),
  });
}

const paymentUrl = (projectId: string, paymentId: string, verb = "") =>
  `/v1/test-sod/projects/${projectId}/payments/${paymentId}${verb === "" ? "" : `/${verb}`}`;

const codeOf = (body: string): unknown => {
  const parsed: unknown = JSON.parse(body);
  return typeof parsed === "object" && parsed !== null
    ? Reflect.get(parsed, "code")
    : undefined;
};

async function historyOf(chainId: string) {
  return asAdmin<{ action: string; actor_id: string; org_id: string }>(
    "SELECT record_type || '.' || action AS action, actor_id::text, org_id::text FROM bricx.sod_actions WHERE chain_id = $1 ORDER BY id",
    [chainId],
  );
}

describe("DW2 and DW3: an elevated finance key, through DbGrantsSource", () => {
  const approveUrl = (payment: string) =>
    `/v1/test-finance/projects/${PROJECT}/payments/${payment}/approve`;

  test("active: 200 at mfa, 401 step-up at pwd; expired: 403 at any acr; never the granter's grants", async () => {
    await asAdmin(
      `INSERT INTO bricx.access_grants (id, org_id, user_id, permission, scope_id, reason, granted_by, starts_at, expires_at, created_at)
       VALUES ($1, $2, $3, 'finance.payment.approve.project', $4, 'p5-07 DW2', $5, $6::timestamptz, $7::timestamptz, $6::timestamptz)`,
      [
        ELEVATION,
        ORG_A,
        users.elevated,
        PROJECT,
        users.requester,
        new Date(T0 - 60_000).toISOString(),
        new Date(T0 + DAY).toISOString(),
      ],
    );
    const payment = nextId();
    expect(
      (await send("POST", approveUrl(payment), users.elevated, ORG_A, "mfa"))
        .statusCode,
    ).toBe(200);
    const pwd = await send(
      "POST",
      approveUrl(payment),
      users.elevated,
      ORG_A,
      "pwd",
    );
    expect(pwd.statusCode).toBe(401);
    expect(codeOf(pwd.body)).toBe("permission.step_up_required");
    expect(pwd.headers["www-authenticate"]).toBe(
      'Bearer error="insufficient_user_authentication", acr_values="mfa"',
    );
    // Past expires_at the source no longer reads it: 403, not a step-up.
    at = T0 + DAY + 1_000;
    try {
      for (const acr of ["mfa", "pwd"]) {
        const res = await send(
          "POST",
          approveUrl(payment),
          users.elevated,
          ORG_A,
          acr,
        );
        expect(res.statusCode).toBe(403);
        expect(codeOf(res.body)).toBe("forbidden");
      }
    } finally {
      at = T0;
    }
  });
});

describe("DW5: every SOD_RULES pair, on the sod_actions history", () => {
  test("the cases come from SOD_RULES (13 rules today, 26 ordered pairs)", () => {
    expect(SOD_RULES.length).toBeGreaterThan(0);
    expect(new Set(SOD_RULES.map((r) => r.id)).size).toBe(SOD_RULES.length);
  });

  const ordered = SOD_RULES.flatMap((rule) => [
    { id: `${rule.id} (first, then second)`, a: rule.first, b: rule.second },
    { id: `${rule.id} (second, then first)`, a: rule.second, b: rule.first },
  ]);

  test.each(ordered)(
    "$id: one actor on one chain is 403 permission.sod_violation; another actor or another chain is allowed",
    async ({ a, b }) => {
      const chain = nextId();
      expect((await act(users.requester, ORG_A, chain, a)).statusCode).toBe(
        200,
      );
      const refused = await act(users.requester, ORG_A, chain, b);
      expect(refused.statusCode).toBe(403);
      expect(JSON.parse(refused.body)).toMatchObject({
        code: "permission.sod_violation",
        key: "errors:permission.sod_violation",
      });
      // Another actor on the same chain: allowed.
      expect((await act(users.manager, ORG_A, chain, b)).statusCode).toBe(200);
      // The same actor on another chain: allowed.
      expect((await act(users.requester, ORG_A, nextId(), b)).statusCode).toBe(
        200,
      );
      expect(
        (await historyOf(chain)).map((r) => [r.action, r.actor_id]),
      ).toEqual([
        [a, users.requester],
        [b, users.manager],
      ]);
    },
  );

  test("the history row is written in the action's transaction: a rollback leaves none, and the conflict is then gone", async () => {
    const chain = nextId();
    const failed = await act(
      users.requester,
      ORG_A,
      chain,
      "finance.payment.request",
      { fail: true },
    );
    expect(failed.statusCode).toBe(500);
    expect(await historyOf(chain)).toEqual([]);
    expect(
      (await act(users.requester, ORG_A, chain, "finance.payment.approve"))
        .statusCode,
    ).toBe(200);
  });

  test("two concurrent opposite sides by one actor on one chain: exactly one succeeds, one row", async () => {
    for (let round = 0; round < 5; round += 1) {
      const chain = nextId();
      const results = await Promise.all([
        act(users.requester, ORG_A, chain, "finance.payment.request"),
        act(users.requester, ORG_A, chain, "finance.payment.approve"),
      ]);
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes).toEqual([200, 403]);
      const refused = results.find((r) => r.statusCode === 403);
      expect(codeOf(refused?.body ?? "{}")).toBe("permission.sod_violation");
      expect(await historyOf(chain)).toHaveLength(1);
    }
  });

  test("an action no rule names is recorded and never refused", async () => {
    const chain = nextId();
    expect(
      (await act(users.requester, ORG_A, chain, "finance.payment.read"))
        .statusCode,
    ).toBe(200);
    expect(
      (await act(users.requester, ORG_A, chain, "finance.payment.read"))
        .statusCode,
    ).toBe(200);
  });

  test("DW8: rows carry the request's org, written by the app role under RLS", async () => {
    const chain = nextId();
    await act(users.requester, ORG_A, chain, "finance.budget.create");
    expect(await historyOf(chain)).toEqual([
      {
        action: "finance.budget.create",
        actor_id: users.requester,
        org_id: ORG_A,
      },
    ]);
  });
});

describe("DW6: elevations never change the actor", () => {
  test("the elevated user's approval is recorded as theirs, not the granter's; the granter requested and could not approve", async () => {
    const payment = nextId();
    const requested = await send(
      "POST",
      paymentUrl(PROJECT, payment, "request"),
      users.requester,
      ORG_A,
      "mfa",
    );
    expect(requested.statusCode).toBe(200);
    // The requester granted the elevation; approving their own request is
    // still refused.
    const own = await send(
      "POST",
      paymentUrl(PROJECT, payment, "approve"),
      users.requester,
      ORG_A,
      "mfa",
    );
    expect(own.statusCode).toBe(403);
    expect(codeOf(own.body)).toBe("permission.sod_violation");
    const approved = await send(
      "POST",
      paymentUrl(PROJECT, payment, "approve"),
      users.elevated,
      ORG_A,
      "mfa",
    );
    expect(approved.statusCode).toBe(200);
    expect(
      (await historyOf(payment)).map((r) => [r.action, r.actor_id]),
    ).toEqual([
      ["finance.payment.request", users.requester],
      ["finance.payment.approve", users.elevated],
    ]);
  });

  test("a requester holding an elevation of the approve key is still refused", async () => {
    // The elevated user requests too (request is not theirs to hold: the
    // fixture's generic probe records it), then approves: refused.
    const chain = nextId();
    expect(
      (await act(users.elevated, ORG_A, chain, "finance.payment.request"))
        .statusCode,
    ).toBe(200);
    const res = await send(
      "POST",
      paymentUrl(PROJECT, chain, "approve"),
      users.elevated,
      ORG_A,
      "mfa",
    );
    expect(res.statusCode).toBe(403);
    expect(codeOf(res.body)).toBe("permission.sod_violation");
  });
});

describe("DW7: D2 = (a), a second approver is mandatory in every org", () => {
  test("single-member org: the request is pending sod_no_approver; the owner's approval is refused, also 30 days later", async () => {
    const payment = nextId();
    const requested = await send(
      "POST",
      paymentUrl(SOLO_PROJECT, payment, "request"),
      users.solo,
      ORG_SOLO,
      "mfa",
    );
    expect(requested.statusCode).toBe(200);
    expect(requested.json()).toEqual({ state: "sod_no_approver" });
    const read = await send(
      "GET",
      paymentUrl(SOLO_PROJECT, payment),
      users.solo,
      ORG_SOLO,
      "mfa",
    );
    expect(read.json()).toEqual({ state: "sod_no_approver" });
    for (const later of [0, 30 * DAY]) {
      at = T0 + later;
      try {
        const res = await send(
          "POST",
          paymentUrl(SOLO_PROJECT, payment, "approve"),
          users.solo,
          ORG_SOLO,
          "mfa",
        );
        expect(res.statusCode).toBe(403);
        expect(codeOf(res.body)).toBe("permission.sod_violation");
      } finally {
        at = T0;
      }
    }
    expect(
      (await historyOf(payment)).map((r) => [r.action, r.actor_id]),
    ).toEqual([["finance.payment.request", users.solo]]);
  });

  test("org A: no other holder is sod_no_approver; an approver joining is awaiting_approval; leaving flips it back; the approver approves at mfa, not at pwd", async () => {
    // The elevation of DW2 expired in its own test's clock only; here the
    // clock is T0 and it is active, so revoke it to start from "nobody".
    await asAdmin(
      "UPDATE bricx.access_grants SET revoked_at = now(), revoked_by = $2 WHERE id = $1",
      [ELEVATION, users.requester],
    );
    const payment = nextId();
    const state = async () =>
      (
        await send(
          "GET",
          paymentUrl(PROJECT, payment),
          users.requester,
          ORG_A,
          "mfa",
        )
      ).json<{ state: string }>().state;
    const requested = await send(
      "POST",
      paymentUrl(PROJECT, payment, "request"),
      users.requester,
      ORG_A,
      "mfa",
    );
    expect(requested.json()).toEqual({ state: "sod_no_approver" });
    await applyAccess(asAdmin, {
      orgId: ORG_A,
      userId: users.approver,
      role: "project_owner",
      projects: [PROJECT],
    });
    expect(await state()).toBe("awaiting_approval");
    await asAdmin(
      "UPDATE bricx.memberships SET removed_at = now() WHERE org_id = $1 AND user_id = $2 AND removed_at IS NULL",
      [ORG_A, users.approver],
    );
    expect(await state()).toBe("sod_no_approver");
    await applyAccess(asAdmin, {
      orgId: ORG_A,
      userId: users.approver,
      role: "project_owner",
      projects: [PROJECT],
    });
    expect(await state()).toBe("awaiting_approval");
    const pwd = await send(
      "POST",
      paymentUrl(PROJECT, payment, "approve"),
      users.approver,
      ORG_A,
      "pwd",
    );
    expect(pwd.statusCode).toBe(401);
    expect(codeOf(pwd.body)).toBe("permission.step_up_required");
    const mfa = await send(
      "POST",
      paymentUrl(PROJECT, payment, "approve"),
      users.approver,
      ORG_A,
      "mfa",
    );
    expect(mfa.statusCode).toBe(200);
    expect(await state()).toBe("approved");
  });

  test("an active elevation of the approve key counts as an approver (D-C); MFA is not needed to count", async () => {
    const payment = nextId();
    // The approver leaves; the accountant is elevated to approve.
    await asAdmin(
      "UPDATE bricx.memberships SET removed_at = now() WHERE org_id = $1 AND user_id = $2 AND removed_at IS NULL",
      [ORG_A, users.approver],
    );
    await send(
      "POST",
      paymentUrl(PROJECT, payment, "request"),
      users.requester,
      ORG_A,
      "mfa",
    );
    const read = () =>
      send("GET", paymentUrl(PROJECT, payment), users.requester, ORG_A, "mfa");
    expect((await read()).json()).toEqual({ state: "sod_no_approver" });
    await asAdmin(
      `INSERT INTO bricx.access_grants (id, org_id, user_id, permission, scope_id, reason, granted_by, starts_at, expires_at, created_at)
       VALUES ($1, $2, $3, 'finance.payment.approve.project', $4, 'p5-07 D-C', $5, $6::timestamptz, $7::timestamptz, $6::timestamptz)`,
      [
        nextId(),
        ORG_A,
        users.accountant,
        PROJECT,
        users.requester,
        new Date(T0 - 60_000).toISOString(),
        new Date(T0 + DAY).toISOString(),
      ],
    );
    expect((await read()).json()).toEqual({ state: "awaiting_approval" });
  });
});
