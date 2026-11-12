// The invitations module without a database (P6-06, ADR 0077): the
// service over plain fakes (the policy check before any transaction, the
// membership-only ability for escalation (ADR 0067 amendment 3), the
// denied event after the rollback, 409 with Location, the outbox payload
// without an address or a token, resend and revoke rules, activate's one
// answer, accept's uniform 404 and its userinfo rules (C3)), the
// boundary schemas, the userinfo client (C3) and the denial recorder (C8).
// End to end, against Postgres and Keycloak: invitations*.int.test.ts.
import type { Tx } from "@bricx/db/database";
import {
  hashInvitationSecret,
  invitationTokenOf,
  newInvitationSecret,
} from "@bricx/db/invitations";
import { PinoLogger } from "nestjs-pino";
import { pino } from "pino";
import { describe, expect, test } from "vitest";
import {
  setSignedInSubject,
  setSignedInUser,
} from "../../src/common/auth/signed-in.decorator.js";
import {
  type Identity,
  runWithRequestContext,
  setIdentity,
} from "../../src/common/db/request-context.js";
import { ApiError } from "../../src/common/errors/api-error.js";
import {
  DENIED_BUCKET_SECONDS,
  DENIED_REASONS,
  DenialRecorder,
  deniedKey,
} from "../../src/modules/audit/public-api.js";
import {
  CreateInvitation,
  InvitationToken,
  ListInvitationsQuery,
  decodeCursor,
  encodeCursor,
} from "../../src/modules/invitations/invitations.dto.js";
import type {
  AcceptRow,
  InvitationRow,
  InvitationsRepository,
} from "../../src/modules/invitations/invitations.repository.js";
import {
  INVITATIONS_ACTIVATE,
  INVITATIONS_SEND,
  InvitationsService,
} from "../../src/modules/invitations/invitations.service.js";
import {
  USERINFO_MAX_BYTES,
  UserinfoRefused,
  UserinfoUnavailable,
  createUserinfoClient,
} from "../../src/modules/invitations/userinfo.js";
import { grantsOf } from "../support/auth.js";

const ORG = "0199e1a0-0000-7000-8000-00000000000a";
const USER = "0199e1a0-0000-7000-8000-000000000001";
const INVITEE = "0199e1a0-0000-7000-8000-000000000003";
const INV = "0199e1a0-0000-7000-8000-0000000000b1";
const ROLE = "0199e1a0-0000-7000-8000-000000000101";
const OWNER_ROLE = "0199e1a0-0000-7000-8000-000000000100";
const PROJECT = "0199e1a0-0000-7000-8000-000000000010";
const SESSION = "0199e1a0-0000-7000-8000-00000000005e";
const CELL = "af-south-1";
const ADDRESS = "invitee@example.test";
const NOW_MS = Date.UTC(2026, 10, 10, 12, 0, 0);
const NOW = new Date(NOW_MS).toISOString();
const LATER = new Date(NOW_MS + 72 * 3_600_000).toISOString();
const SUB = "kc-sub-1";
const NEEDLE = "needle-6d1e";

const identity = (roles: readonly string[]): Identity => ({
  orgId: ORG,
  userId: USER,
  projectIds: [],
  allProjects: true,
  grants: grantsOf({ roles }),
  membershipGrants: grantsOf({ roles }),
  sessionId: SESSION,
  deviceId: undefined,
  acr: "mfa",
});

const row = (over: Partial<AcceptRow> = {}): AcceptRow => ({
  id: INV,
  orgId: ORG,
  projectId: null,
  email: ADDRESS,
  roleId: ROLE,
  projectRoleId: null,
  storedStatus: "pending",
  status: "pending",
  sendSeq: 1,
  resendCount: 0,
  activationCount: 0,
  expiresAt: LATER,
  lastSentAt: null,
  invitedBy: USER,
  acceptedBy: null,
  acceptedAt: null,
  revokedBy: null,
  revokedAt: null,
  revokeReason: null,
  createdAt: NOW,
  // P6-06b (ADR 0084): internal, permanent.
  external: false,
  membershipExpiresAt: null,
  tokenHash: null,
  ...over,
});

/** A transaction: SQL answers no rows; the TTL select answers none. */
const selectNone = () => ({
  from: () => ({ where: () => Promise.resolve([]) }),
});
const tx = {
  execute: () => Promise.resolve({ rows: [] }),
  select: selectNone,
} as unknown as Tx;

const logger = () =>
  new PinoLogger<never>({ pinoHttp: { logger: pino({ level: "silent" }) } });

interface World {
  roles?: Record<string, { systemKey: string | null; keys: string[] }>;
  found?: AcceptRow | undefined;
  insert?: InvitationRow | undefined;
  pendingId?: string | undefined;
  resend?: InvitationRow | undefined;
  revoke?: InvitationRow | undefined;
  activate?: boolean;
  byHash?: { id: string; orgId: string; invitedBy: string } | undefined;
  userinfo?: () => Promise<{
    sub: string;
    email: string | undefined;
    emailVerified: boolean;
  }>;
  project?: { status: string } | undefined;
}

function harness(world: World = {}) {
  const calls: string[] = [];
  const enqueued: { topic: string; payload: unknown }[] = [];
  const audits: { action: string; after?: unknown; system: boolean }[] = [];
  const denials: { reason: string }[] = [];
  const scheduled: { kind: string; expiresAt: string }[] = [];
  let lookups = 0;
  const runner = {
    run: <T>(fn: (t: Tx) => Promise<T>) => {
      calls.push("tx");
      return fn(tx);
    },
    runAs: <T>(_ctx: unknown, fn: (t: Tx) => Promise<T>) => {
      calls.push("runAs");
      // The definer lookup by hash (the first statement of the harness)
      // answers the world's ref; every later statement answers no rows.
      return fn({
        select: selectNone,
        execute: () =>
          Promise.resolve({
            rows:
              world.byHash === undefined || lookups++ > 0
                ? []
                : [
                    {
                      id: world.byHash.id,
                      org_id: world.byHash.orgId,
                      invited_by: world.byHash.invitedBy,
                    },
                  ],
          }),
      } as unknown as Tx);
    },
    runSignedIn: <T>(_org: string, fn: (t: Tx) => Promise<T>) =>
      runner.runAs(undefined, fn),
  };
  const repo = {
    find: () => Promise.resolve(world.found),
    findForAccept: () => Promise.resolve(world.found),
    list: (_t: Tx, _o: string, filter: { limit: number }) =>
      Promise.resolve(
        Array.from({ length: Math.min(filter.limit, 3) }, (_, i) =>
          row({ id: `0199e1a0-0000-7000-8000-0000000000c${String(i)}` }),
        ),
      ),
    expireStale: () =>
      Promise.resolve([
        { id: INV, projectId: null, status: "expired", revokeReason: null },
      ]),
    insert: () => Promise.resolve("insert" in world ? world.insert : row()),
    pendingId: () => Promise.resolve(world.pendingId),
    resend: () => Promise.resolve(world.resend),
    revoke: () => {
      calls.push("revoke");
      return Promise.resolve(world.revoke);
    },
    activate: () => Promise.resolve(world.activate ?? true),
    accept: () => Promise.resolve(true),
    orgArchived: () => Promise.resolve(false),
  } as unknown as InvitationsRepository;
  const roles = world.roles ?? {
    [ROLE]: { systemKey: null, keys: ["project.milestone.read.org"] },
    [OWNER_ROLE]: { systemKey: "owner", keys: [] },
  };
  const rolesRepo = {
    findOpen: (_t: Tx, _o: string, id: string) =>
      Promise.resolve(
        roles[id] === undefined
          ? undefined
          : { id, systemKey: roles[id].systemKey },
      ),
    bundles: (_t: Tx, _o: string, ids: readonly string[]) =>
      Promise.resolve(new Map(ids.map((id) => [id, roles[id]?.keys ?? []]))),
  };
  const service = new InvitationsService(
    runner as never,
    repo,
    {
      insertOrgIfAbsent: () => Promise.resolve({ id: "m" }),
      insertProjectIfAbsent: () => Promise.resolve(undefined),
    } as never,
    rolesRepo as never,
    {
      stateOf: () =>
        Promise.resolve(
          "project" in world ? world.project : { status: "active" },
        ),
    },
    {
      record: (_t: Tx, e: { action: string; after?: unknown }) => {
        audits.push({ action: e.action, after: e.after, system: false });
        return Promise.resolve();
      },
      recordSystem: (_t: Tx, e: { action: string; after?: unknown }) => {
        audits.push({ action: e.action, after: e.after, system: true });
        return Promise.resolve();
      },
    } as never,
    {
      enqueue: (_t: Tx, topic: string, payload: unknown) => {
        enqueued.push({ topic, payload });
        return Promise.resolve();
      },
    } as never,
    {
      record: (d: { reason: string }) => {
        denials.push({ reason: d.reason });
        return Promise.resolve("recorded" as const);
      },
    },
    {
      read:
        world.userinfo ??
        (() =>
          Promise.resolve({ sub: SUB, email: ADDRESS, emailVerified: true })),
    },
    CELL,
    5,
    { now: () => NOW_MS },
    logger(),
    // P6-06b (ADR 0084): the expiry job and notice of a temporary membership.
    {
      scheduleExpiry: (_t: Tx, input: { kind: string; expiresAt: string }) => {
        scheduled.push({ kind: input.kind, expiresAt: input.expiresAt });
        return Promise.resolve();
      },
    },
  );
  return { service, calls, enqueued, audits, denials, scheduled };
}

const asIdentity = <T>(who: Identity | undefined, fn: () => Promise<T>) =>
  runWithRequestContext(
    { correlationId: "corr-1", ip: "127.0.0.1", deviceId: undefined },
    async () => {
      if (who !== undefined) setIdentity(who);
      return fn();
    },
  );
const asSignedIn = <T>(userId: string, sub: string, fn: () => Promise<T>) =>
  runWithRequestContext(
    { correlationId: "corr-1", ip: "127.0.0.1", deviceId: undefined },
    async () => {
      setSignedInUser({ userId, acr: "mfa" });
      setSignedInSubject(sub);
      return fn();
    },
  );

async function apiError(work: () => Promise<unknown>): Promise<ApiError> {
  try {
    await work();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected an ApiError");
}

const create = { email: ADDRESS, roleId: ROLE } as never;

describe("create (D13, D12, D4)", () => {
  test("no org.member.invite: 403 before any transaction", async () => {
    const h = harness();
    const error = await apiError(() =>
      asIdentity(identity(["member"]), () => h.service.create(create)),
    );
    expect(error.code).toBe("forbidden");
    expect(h.calls).toEqual([]);
  });

  test("the owner invites: one row, one invitations.send with ids and the send number only, one create event; a stale pending row is expired first (system)", async () => {
    const h = harness();
    const out = await asIdentity(identity(["owner"]), () =>
      h.service.create(create),
    );
    expect(out).toMatchObject({ id: INV, status: "pending", email: ADDRESS });
    expect(h.enqueued).toEqual([
      {
        topic: INVITATIONS_SEND,
        payload: { invitationId: INV, sendSeq: 1, invitedBy: USER },
      },
    ]);
    expect(h.audits.map((a) => [a.action, a.system])).toEqual([
      ["org.invitation.expire", true],
      ["org.invitation.create", false],
    ]);
    expect(JSON.stringify(h.audits)).not.toContain(ADDRESS);
  });

  test("escalation: a role key the inviter's MEMBERSHIP does not hold is 403 and one denied event (after the rollback)", async () => {
    const h = harness({
      roles: {
        [ROLE]: {
          systemKey: null,
          keys: ["finance.budget.approve.project"],
        },
      },
    });
    const admin: Identity = {
      ...identity(["administrator"]),
      // An elevation never lets someone grant (ADR 0067 amendment 3).
      grants: grantsOf({ roles: ["owner"] }),
    };
    const error = await apiError(() =>
      asIdentity(admin, () => h.service.create(create)),
    );
    expect(error.code).toBe("forbidden");
    expect(h.denials).toEqual([{ reason: "escalation" }]);
    expect(h.enqueued).toEqual([]);
  });

  test("an unknown role is 404; a project invitation on an archived project is 409, an unknown one 404", async () => {
    const h = harness();
    expect(
      (
        await apiError(() =>
          asIdentity(identity(["owner"]), () =>
            h.service.create({ email: ADDRESS, roleId: INV }),
          ),
        )
      ).code,
    ).toBe("not_found");
    const withProject = {
      email: ADDRESS,
      roleId: ROLE,
      projectId: PROJECT,
      projectRoleId: ROLE,
    } as never;
    expect(
      (
        await apiError(() =>
          asIdentity(identity(["owner"]), () =>
            harness({ project: { status: "archived" } }).service.create(
              withProject,
            ),
          ),
        )
      ).code,
    ).toBe("request.conflict");
    expect(
      (
        await apiError(() =>
          asIdentity(identity(["owner"]), () =>
            harness({ project: undefined }).service.create(withProject),
          ),
        )
      ).code,
    ).toBe("not_found");
    const ok = harness();
    await asIdentity(identity(["owner"]), () => ok.service.create(withProject));
    expect(ok.enqueued).toHaveLength(1);
  });

  test("a pending invitation exists: 409 invitation.pending_exists with its Location; none found: no Location", async () => {
    const error = await apiError(() =>
      asIdentity(identity(["owner"]), () =>
        harness({ insert: undefined, pendingId: INV }).service.create(create),
      ),
    );
    expect(error.code).toBe("invitation.pending_exists");
    expect(error.location).toBe(`/v1/invitations/${INV}`);
    const bare = await apiError(() =>
      asIdentity(identity(["owner"]), () =>
        harness({ insert: undefined }).service.create(create),
      ),
    );
    expect(bare.location).toBeUndefined();
  });
});

describe("list, get, resend, revoke", () => {
  test("list: limit + 1 read, a cursor when more", async () => {
    const h = harness();
    const page = await asIdentity(identity(["owner"]), () =>
      h.service.list({ limit: 2 }),
    );
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe(encodeCursor(page.items[1]?.id ?? ""));
    const all = await asIdentity(identity(["owner"]), () =>
      h.service.list({ cursor: encodeCursor(INV) }),
    );
    expect(all.nextCursor).toBeNull();
  });

  test("get: 404 when absent", async () => {
    expect(
      (
        await apiError(() =>
          asIdentity(identity(["owner"]), () => harness().service.get(INV)),
        )
      ).code,
    ).toBe("not_found");
    const found = await asIdentity(identity(["owner"]), () =>
      harness({ found: row() }).service.get(INV),
    );
    expect(found.id).toBe(INV);
  });

  test("resend: 404, 409 when not pending, 409 resend_limit at the cap, 409 when the update loses; else a new send", async () => {
    const at = (w: World) =>
      apiError(() =>
        asIdentity(identity(["owner"]), () => harness(w).service.resend(INV)),
      );
    expect((await at({})).code).toBe("not_found");
    expect((await at({ found: row({ status: "expired" }) })).code).toBe(
      "request.conflict",
    );
    expect((await at({ found: row({ resendCount: 5 }) })).code).toBe(
      "invitation.resend_limit",
    );
    expect((await at({ found: row() })).code).toBe("request.conflict");
    const h = harness({
      found: row(),
      resend: row({ sendSeq: 2, resendCount: 1 }),
    });
    await asIdentity(identity(["owner"]), () => h.service.resend(INV));
    expect(h.enqueued).toEqual([
      {
        topic: INVITATIONS_SEND,
        payload: { invitationId: INV, sendSeq: 2, invitedBy: USER },
      },
    ]);
    expect(h.audits.map((a) => a.action)).toEqual(["org.invitation.resend"]);
  });

  test("revoke: idempotent on revoked; 409 on accepted or expired; 404 absent; else one revoke event with reason manual", async () => {
    const at = (w: World) =>
      asIdentity(identity(["owner"]), () => harness(w).service.revoke(INV));
    await expect(at({ found: row({ status: "revoked" }) })).resolves.toBe(
      undefined,
    );
    for (const status of ["accepted", "expired"] as const) {
      expect((await apiError(() => at({ found: row({ status }) }))).code).toBe(
        "request.conflict",
      );
    }
    expect((await apiError(() => at({}))).code).toBe("not_found");
    expect((await apiError(() => at({ found: row() }))).code).toBe(
      "request.conflict",
    );
    const h = harness({ found: row(), revoke: row({ status: "revoked" }) });
    await asIdentity(identity(["owner"]), () => h.service.revoke(INV));
    expect(h.audits).toEqual([
      {
        action: "org.invitation.revoke",
        after: expect.objectContaining({ reason: "manual" }) as unknown,
        system: false,
      },
    ]);
  });
});

describe("activate (D6): always 202", () => {
  const secret = newInvitationSecret();
  const token = invitationTokenOf(CELL, secret);
  const ref = { id: INV, orgId: ORG, invitedBy: USER };

  test("malformed, another cell, unknown, a hash mismatch, not pending, the limit: the same answer, no outbox row", async () => {
    for (const [t, w] of [
      [NEEDLE, {}],
      [invitationTokenOf("eu-west-1", secret), {}],
      [token, {}],
      [token, { byHash: ref, found: row({ tokenHash: Buffer.alloc(32) }) }],
      [
        token,
        {
          byHash: ref,
          found: row({
            tokenHash: hashInvitationSecret(secret),
            status: "accepted",
          }),
        },
      ],
      [
        token,
        {
          byHash: ref,
          found: row({ tokenHash: hashInvitationSecret(secret) }),
          activate: false,
        },
      ],
    ] as const) {
      const h = harness(w);
      expect(await h.service.activate(t)).toEqual({ status: "accepted" });
      expect(h.enqueued).toEqual([]);
    }
  });

  test("a good token: one invitations.activate with ids only", async () => {
    const h = harness({
      byHash: ref,
      found: row({ tokenHash: hashInvitationSecret(secret) }),
    });
    expect(await h.service.activate(token)).toEqual({ status: "accepted" });
    expect(h.enqueued).toEqual([
      {
        topic: INVITATIONS_ACTIVATE,
        payload: { invitationId: INV, invitedBy: USER },
      },
    ]);
  });
});

describe("accept (D7, D8, C3)", () => {
  const secret = newInvitationSecret();
  const token = invitationTokenOf(CELL, secret);
  const hash = hashInvitationSecret(secret);
  const ref = { id: INV, orgId: ORG, invitedBy: USER };
  const accept = (w: World, user = INVITEE, sub = SUB) =>
    apiError(() =>
      asSignedIn(user, sub, () => harness(w).service.accept(token, "bearer")),
    );

  test("a token that names nothing: 404 invitation.unavailable before userinfo", async () => {
    let asked = 0;
    const error = await accept({
      userinfo: () => {
        asked += 1;
        return Promise.reject(new Error("unused"));
      },
    });
    expect(error.code).toBe("invitation.unavailable");
    expect(asked).toBe(0);
  });

  test("userinfo refused: 401; down: 503", async () => {
    expect(
      (
        await accept({
          byHash: ref,
          userinfo: () => Promise.reject(new UserinfoRefused()),
        })
      ).code,
    ).toBe("unauthenticated");
    expect(
      (
        await accept({
          byHash: ref,
          userinfo: () => Promise.reject(new UserinfoUnavailable()),
        })
      ).code,
    ).toBe("server_unavailable");
  });

  test("C3: another sub, email_verified not true, or no address: the uniform 404", async () => {
    for (const answer of [
      { sub: "someone-else", email: ADDRESS, emailVerified: true },
      { sub: SUB, email: ADDRESS, emailVerified: false },
      { sub: SUB, email: undefined, emailVerified: true },
    ]) {
      const h = harness({
        byHash: ref,
        found: row({ tokenHash: hash }),
        userinfo: () => Promise.resolve(answer),
      });
      const error = await apiError(() =>
        asSignedIn(INVITEE, SUB, () => h.service.accept(token, "bearer")),
      );
      expect(error.code).toBe("invitation.unavailable");
      // Refused at the userinfo check (S6, S18): the token lookup is the
      // only transaction; nothing reaches the accept transaction.
      expect(h.calls).toEqual(["runAs"]);
    }
  });

  test("the inviter accepting their own invitation: 404 and one self_invite denial", async () => {
    const h = harness({ byHash: ref });
    const error = await apiError(() =>
      asSignedIn(USER, SUB, () => h.service.accept(token, "bearer")),
    );
    expect(error.code).toBe("invitation.unavailable");
    expect(h.denials).toEqual([{ reason: "self_invite" }]);
  });

  test("inside the transaction: hash, status, address, project, role: each the uniform 404", async () => {
    for (const found of [
      undefined,
      row({ tokenHash: Buffer.alloc(32) }),
      row({ tokenHash: hash, status: "revoked" }),
      row({ tokenHash: hash, email: "other@example.test" }),
      row({ tokenHash: hash, roleId: INV }),
    ]) {
      const h = harness({ byHash: ref, found });
      const error = await apiError(() =>
        asSignedIn(INVITEE, SUB, () => h.service.accept(token, "bearer")),
      );
      expect(error.code).toBe("invitation.unavailable");
      // Refused by its own check (S1, S14), not by the later inviter
      // re-check, which would revoke the row.
      expect(h.calls).not.toContain("revoke");
    }
    expect(
      (
        await accept({
          byHash: ref,
          found: row({ tokenHash: hash, projectId: PROJECT }),
          project: { status: "archived" },
        })
      ).code,
    ).toBe("invitation.unavailable");
  });

  test("the inviter no longer holds the role (no membership rows): revoked inviter_lacks_rights as system, one denial, the uniform 404 (S17)", async () => {
    const h = harness({
      byHash: ref,
      found: row({ tokenHash: hash }),
      revoke: row({ status: "revoked" }),
    });
    const error = await apiError(() =>
      asSignedIn(INVITEE, SUB, () => h.service.accept(token, "bearer")),
    );
    expect(error.code).toBe("invitation.unavailable");
    expect(h.calls).toContain("revoke");
    expect(h.audits).toEqual([
      {
        action: "org.invitation.revoke",
        after: expect.objectContaining({
          reason: "inviter_lacks_rights",
        }) as unknown,
        system: true,
      },
    ]);
    expect(h.denials).toEqual([{ reason: "inviter_lacks_rights" }]);
  });

  test("not signed in: 401", async () => {
    const error = await apiError(() =>
      runWithRequestContext(
        { correlationId: "c", ip: "127.0.0.1", deviceId: undefined },
        () => harness().service.accept(token, "bearer"),
      ),
    );
    expect(error.code).toBe("unauthenticated");
  });
});

describe("the boundary schemas", () => {
  test("create: the address is normalised; project id and project role together or neither; bounded", () => {
    expect(
      CreateInvitation.schema.parse({
        email: " Invitee@Example.TEST ",
        roleId: ROLE,
      }),
    ).toEqual({ email: ADDRESS, roleId: ROLE });
    for (const bad of [
      { email: "nope", roleId: ROLE },
      { email: ADDRESS, roleId: ROLE, projectId: PROJECT },
      { email: ADDRESS, roleId: ROLE, projectRoleId: ROLE },
      { email: `${"a".repeat(400)}@example.test`, roleId: ROLE },
      { email: ADDRESS, roleId: ROLE, extra: 1 },
    ]) {
      expect(CreateInvitation.schema.safeParse(bad).success).toBe(false);
    }
  });

  test("list query and cursors; a token is bounded", () => {
    expect(decodeCursor(encodeCursor(INV))).toBe(INV);
    expect(decodeCursor(NEEDLE)).toBeUndefined();
    expect(
      ListInvitationsQuery.schema.safeParse({ limit: "101" }).success,
    ).toBe(false);
    expect(
      InvitationToken.schema.safeParse({ token: "x".repeat(200) }).success,
    ).toBe(false);
  });
});

describe("the userinfo client (C3)", () => {
  const client = (respond: () => Response | Promise<Response>) => {
    const asked: { url: string; init: RequestInit | undefined }[] = [];
    const fake = ((url: string, init?: RequestInit) => {
      asked.push({ url, init });
      return Promise.resolve(respond());
    }) as unknown as typeof fetch;
    return {
      asked,
      userinfo: createUserinfoClient({
        url: "https://id.example.test/realms/bricx/protocol/openid-connect/userinfo",
        fetch: fake,
      }),
    };
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  test("one GET of the configured URL with the caller's bearer, no redirect, no cache; email_verified only for true", async () => {
    const c = client(() =>
      json({ sub: SUB, email: ADDRESS, email_verified: "true" }),
    );
    expect(await c.userinfo.read("tok")).toEqual({
      sub: SUB,
      email: ADDRESS,
      emailVerified: false,
    });
    expect(c.asked[0]?.url).toContain("/protocol/openid-connect/userinfo");
    expect(c.asked[0]?.init).toMatchObject({
      method: "GET",
      redirect: "error",
      cache: "no-store",
    });
    expect(
      (c.asked[0]?.init?.headers as Record<string, string>).authorization,
    ).toBe("Bearer tok");
    const ok = client(() =>
      json({ sub: SUB, email: ADDRESS, email_verified: true }),
    );
    expect((await ok.userinfo.read("tok")).emailVerified).toBe(true);
  });

  test("401/403 refused; 5xx, a network error, a non-object, no sub, too large: unavailable", async () => {
    await expect(
      client(() => json({}, 401)).userinfo.read("t"),
    ).rejects.toBeInstanceOf(UserinfoRefused);
    await expect(
      client(() => json({}, 403)).userinfo.read("t"),
    ).rejects.toBeInstanceOf(UserinfoRefused);
    for (const respond of [
      () => json({}, 502),
      () => Promise.reject(new Error(NEEDLE)),
      () => json([1]),
      () => json("x"),
      () => json({ email: ADDRESS }),
      () => new Response("not json"),
      () =>
        new Response("{}", {
          headers: { "content-length": String(USERINFO_MAX_BYTES + 1) },
        }),
      () => new Response(`{"sub":"${"x".repeat(USERINFO_MAX_BYTES)}"}`),
    ]) {
      const error = await client(respond)
        .userinfo.read("t")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UserinfoUnavailable);
      expect(String(error)).not.toContain(NEEDLE);
    }
  });
});

describe("the denial recorder (C8)", () => {
  function recorder(set: () => Promise<string | null>) {
    const written: unknown[] = [];
    const valkey = {
      status: "ready",
      set: () => set(),
      connect: () => Promise.resolve(),
    };
    const denials = new DenialRecorder(
      valkey as never,
      {
        runAs: <T>(_ctx: unknown, fn: (t: Tx) => Promise<T>) => fn(tx),
      },
      {
        record: (_t: Tx, event: unknown) => {
          written.push(event);
          return Promise.resolve();
        },
      } as never,
      logger(),
    );
    return { denials, written };
  }
  const denial = {
    orgId: ORG,
    actorId: USER,
    reason: "escalation" as const,
    entityId: INV,
  };

  test("a closed enum; the key is org + actor + reason; 15-minute buckets", () => {
    expect(DENIED_REASONS).toEqual([
      "escalation",
      "self_role_change",
      "inviter_lacks_rights",
      "self_invite",
      // P6-06b (ADR 0084): no member suspends, reactivates or renews themselves.
      "self_suspend",
      "self_renew",
    ]);
    expect(deniedKey(ORG, USER, "escalation")).toBe(
      `bricx:denied:${ORG}:${USER}:escalation`,
    );
    expect(DENIED_BUCKET_SECONDS).toBe(900);
  });

  test("the first in a bucket writes one event with the reason only; a repeat writes none; Valkey down writes none", async () => {
    const first = recorder(() => Promise.resolve("OK"));
    expect(await first.denials.record(denial)).toBe("recorded");
    expect(first.written).toEqual([
      {
        action: "org.invitation.denied",
        entityType: "org.invitation",
        entityId: INV,
        after: { reason: "escalation" },
      },
    ]);
    const repeat = recorder(() => Promise.resolve(null));
    expect(await repeat.denials.record(denial)).toBe("repeat");
    expect(repeat.written).toEqual([]);
    const down = recorder(() => Promise.reject(new Error(NEEDLE)));
    expect(await down.denials.record(denial)).toBe("unrecorded");
    expect(down.written).toEqual([]);
  });

  test("a reason outside the enum, or a bad id, is a programming error before any I/O", async () => {
    let asked = 0;
    const r = recorder(() => {
      asked += 1;
      return Promise.resolve("OK");
    });
    await expect(
      r.denials.record({ ...denial, reason: NEEDLE as never }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      r.denials.record({ ...denial, orgId: NEEDLE }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(asked).toBe(0);
  });
});
