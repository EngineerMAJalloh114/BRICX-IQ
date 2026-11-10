// The invitations consumer (P6-06, ADR 0077, D4-D6, D10; owner conditions
// C2, C7 S20), over fakes:
// - payloads are checked before anything runs (exactly the registered
//   keys; UUIDs; sendSeq a positive integer): a bad one is unrecoverable;
// - send: the token is minted in ONE bricx_app transaction in the org as
//   the inviter, with a fresh secret whose SHA-256 is what is stored; a
//   stale send (mint answers nothing) sends nothing; the e-mail is written
//   in the org's language with the link <base>/invite#<cell>.<secret> and
//   the end in the org's time zone; no adapter throws before minting; a
//   failing adapter throws (retried), and the retry mints a NEW token;
// - activate: a settled invitation touches no account; a pending one asks
//   Keycloak, with the action link's life bounded to 1 h..7 d;
// - the Keycloak provisioner: no account -> created with VERIFY_EMAIL and
//   UPDATE_PASSWORD and e-mailed; unverified -> its pending actions
//   e-mailed again; verified or disabled -> nothing; two accounts -> throws;
// - the sweep expires each due invitation in its own org with a
//   sweep.<id> correlation, going on past a failure;
// - expiry writes org.invitation.expire as `system` in the same
//   transaction, only when the row changed;
// - logs carry ids, counts and codes, never an address, a token or a
//   message.
// Live, against Postgres, Valkey, Keycloak and the e-mail adapter:
// invitations.int.test.ts.
import { createHash } from "node:crypto";
import { createNullEmail } from "@bricx/adapters/email";
import { nullPayment } from "@bricx/adapters/null";
import type { EmailMessage } from "@bricx/adapters/types";
import type { Tx, TxContext } from "@bricx/db/database";
import type {
  InvitationRef,
  MintedInvitation,
  SettledInvitation,
} from "@bricx/db/invitations";
import { OUTBOX_TOPICS } from "@bricx/db/outbox";
import { UnrecoverableError } from "bullmq";
import { describe, expect, test } from "vitest";
import {
  ACTION_LINK_MAX_SECONDS,
  ACTION_LINK_MIN_SECONDS,
  actionLinkSeconds,
  createInvitationActivator,
} from "../src/invitations/activate.js";
import {
  INVITATIONS_ACTIVATE,
  INVITATIONS_QUEUE,
  INVITATIONS_SEND,
  INVITATIONS_SWEEP,
  INVITATIONS_SWEEP_EVERY_MS,
  INVITATIONS_SWEEP_LIMIT,
  type InvitationDeps,
  onInvitationFailed,
  parseInvitationActivate,
  parseInvitationSend,
  processInvitationJob,
  scheduleInvitationSweep,
} from "../src/invitations/consumer.js";
import { dueInvitationReader } from "../src/invitations/due.js";
import {
  INVITATION_EXPIRE_ACTION,
  INVITATION_SUBJECT,
  createInvitationExpirer,
} from "../src/invitations/expiry.js";
import {
  EmailUnavailableError,
  createInvitationSender,
  invitationEmail,
} from "../src/invitations/send.js";
import {
  type AccountApi,
  NEW_ACCOUNT_ACTIONS,
  accountProvisionerOver,
} from "../src/revocation/keycloak.js";
import { emailAdapterOf } from "../src/relay/boot.js";

const ORG = "0199e1a0-0000-7000-8000-00000000000a";
const INVITER = "0199e1a0-0000-7000-8000-000000000002";
const INV = "0199e1a0-0000-7000-8000-0000000000b1";
const INV_B = "0199e1a0-0000-7000-8000-0000000000b2";
const OUTBOX = "0199e1a0-0000-7000-8000-0000000000e1";
const ADDRESS = "invitee-7f3a@example.test";
const NEEDLE = "needle-91d0: a value that must stay out of the logs";
const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const EXPIRES = "2026-11-13T12:00:00.000Z";

type Logged = { level: string; msg: string; fields: Record<string, unknown> };
function recorder() {
  const lines: Logged[] = [];
  const at =
    (level: string) => (fields: Record<string, unknown>, msg: string) => {
      lines.push({ level, msg, fields });
    };
  return {
    lines,
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
}

const sendJob = (
  payload: unknown = {
    invitationId: INV,
    sendSeq: 1,
    invitedBy: INVITER,
  },
  orgId: unknown = ORG,
) => ({
  name: INVITATIONS_SEND,
  data: { outboxId: OUTBOX, topic: INVITATIONS_SEND, orgId, payload },
  attemptsMade: 0,
  opts: { attempts: 40 },
});
const activateJob = (
  payload: unknown = {
    invitationId: INV,
    invitedBy: INVITER,
  },
) => ({
  name: INVITATIONS_ACTIVATE,
  data: { outboxId: OUTBOX, topic: INVITATIONS_ACTIVATE, orgId: ORG, payload },
  attemptsMade: 0,
  opts: { attempts: 40 },
});

/** A withTx() fake: records each context; the callback gets a token tx. */
function fakeDatabase() {
  const contexts: TxContext[] = [];
  const tx = { fake: "tx" } as unknown as Tx;
  return {
    contexts,
    tx,
    withTx<T>(context: TxContext, fn: (t: Tx) => Promise<T>): Promise<T> {
      contexts.push(context);
      return fn(tx);
    },
  };
}

const allText = (lines: Logged[]) => JSON.stringify(lines);

describe("the topics and the schedule", () => {
  test("both topics go to queue invitations with the registered keys", () => {
    expect(OUTBOX_TOPICS[INVITATIONS_SEND]?.queue).toBe(INVITATIONS_QUEUE);
    expect(OUTBOX_TOPICS[INVITATIONS_ACTIVATE]?.queue).toBe(INVITATIONS_QUEUE);
    expect(OUTBOX_TOPICS[INVITATIONS_SEND]?.keys).toEqual([
      "invitationId",
      "sendSeq",
      "invitedBy",
    ]);
    expect(OUTBOX_TOPICS[INVITATIONS_ACTIVATE]?.keys).toEqual([
      "invitationId",
      "invitedBy",
    ]);
  });

  test("the sweep runs every minute, at most 100 rows, under one scheduler id", async () => {
    expect(INVITATIONS_SWEEP_EVERY_MS).toBe(60_000);
    expect(INVITATIONS_SWEEP_LIMIT).toBe(100);
    const calls: unknown[][] = [];
    await scheduleInvitationSweep({
      schedule: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve();
      },
    });
    expect(calls).toEqual([
      [INVITATIONS_QUEUE, INVITATIONS_SWEEP, 60_000, INVITATIONS_SWEEP],
    ]);
  });
});

describe("payloads", () => {
  test("accepts the registered payloads with the row's org", () => {
    expect(parseInvitationSend(sendJob())).toEqual({
      invitationId: INV,
      sendSeq: 1,
      invitedBy: INVITER,
      orgId: ORG,
    });
    expect(parseInvitationActivate(activateJob())).toEqual({
      invitationId: INV,
      invitedBy: INVITER,
      orgId: ORG,
    });
  });

  test.each([
    [
      "an extra key",
      { invitationId: INV, sendSeq: 1, invitedBy: INVITER, email: ADDRESS },
    ],
    ["a missing key", { invitationId: INV, invitedBy: INVITER }],
    [
      "sendSeq as a string",
      { invitationId: INV, sendSeq: "1", invitedBy: INVITER },
    ],
    ["sendSeq 0", { invitationId: INV, sendSeq: 0, invitedBy: INVITER }],
    ["sendSeq 1.5", { invitationId: INV, sendSeq: 1.5, invitedBy: INVITER }],
    [
      "sendSeq past every resend",
      { invitationId: INV, sendSeq: 22, invitedBy: INVITER },
    ],
    ["a non-UUID id", { invitationId: NEEDLE, sendSeq: 1, invitedBy: INVITER }],
    ["no payload", null],
  ])("send: %s is unrecoverable, without the value", (_label, payload) => {
    let caught: unknown;
    try {
      parseInvitationSend(sendJob(payload));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnrecoverableError);
    expect(String(caught)).not.toContain(NEEDLE);
  });

  test("a bad org or a wrong job name is unrecoverable", () => {
    expect(() => parseInvitationSend(sendJob(undefined, NEEDLE))).toThrow(
      UnrecoverableError,
    );
    expect(() =>
      parseInvitationSend({ ...sendJob(), name: INVITATIONS_ACTIVATE }),
    ).toThrow(UnrecoverableError);
    expect(() =>
      parseInvitationActivate(
        activateJob({ invitationId: INV, invitedBy: INVITER, sendSeq: 1 }),
      ),
    ).toThrow(UnrecoverableError);
  });
});

describe("send (D4, D5, C7 S20)", () => {
  const settings = { language: "fr", timezone: "Africa/Freetown" };

  function sender(
    over: {
      email?: ReturnType<typeof createNullEmail> | undefined;
      mint?: MintedInvitation | undefined;
      noAdapter?: boolean;
    } = {},
  ) {
    const database = fakeDatabase();
    const captured: EmailMessage[] = [];
    const email =
      over.noAdapter === true
        ? undefined
        : (over.email ??
          createNullEmail({
            capture: (m) => {
              captured.push(m);
            },
          }));
    const mints: { id: string; sendSeq: number; hash: Buffer; now: string }[] =
      [];
    const minted: MintedInvitation | undefined =
      "mint" in over
        ? over.mint
        : { id: INV, email: ADDRESS, expiresAt: EXPIRES };
    const send = createInvitationSender({
      database,
      clock: { now: () => NOW },
      email,
      linkBase: "https://app.bricx.example",
      cellId: "af-south-1",
      statements: {
        mint: (_tx, input) => {
          mints.push(input);
          return Promise.resolve(minted);
        },
        settings: (_tx, orgId) => {
          expect(orgId).toBe(ORG);
          return Promise.resolve(settings);
        },
      },
    });
    return { send, database, captured, mints };
  }
  const job = { invitationId: INV, orgId: ORG, invitedBy: INVITER, sendSeq: 2 };

  test("mints in ONE transaction in the org as the inviter; the link's secret hashes to what was stored; the e-mail is French", async () => {
    const s = sender();
    expect(await s.send.send(job)).toBe("sent");
    expect(s.database.contexts).toEqual([
      { orgId: ORG, userId: INVITER, projectIds: [] },
    ]);
    expect(s.mints).toHaveLength(1);
    expect(s.mints[0]).toMatchObject({
      id: INV,
      sendSeq: 2,
      now: new Date(NOW).toISOString(),
    });
    const [message] = s.captured;
    expect(message?.to).toBe(ADDRESS);
    expect(message?.locale).toBe("fr");
    expect(message?.subject).toBe("Vous avez été invité sur BRICX IQ");
    const link =
      /https:\/\/app\.bricx\.example\/invite#af-south-1\.([A-Za-z0-9_-]{43})/.exec(
        message?.text ?? "",
      );
    expect(link).not.toBeNull();
    const secret = link?.[1] ?? "";
    const stored = s.mints[0]?.hash;
    expect(
      createHash("sha256").update(Buffer.from(secret, "base64url")).digest(),
    ).toEqual(stored);
    // The end, in the org's time zone (Freetown is UTC+0), in French.
    expect(message?.text).toContain("13 novembre 2026");
  });

  test("a stale send (a resend's older job, a settled row): nothing is sent", async () => {
    const s = sender({ mint: undefined });
    expect(await s.send.send(job)).toBe("stale");
    expect(s.captured).toEqual([]);
  });

  test("no e-mail adapter (production until P12): throws before any transaction (retried, never dropped)", async () => {
    const s = sender({ noAdapter: true });
    await expect(s.send.send(job)).rejects.toBeInstanceOf(
      EmailUnavailableError,
    );
    expect(s.database.contexts).toEqual([]);
  });

  test("a failing adapter throws; the retry mints a NEW token (the unsent one never works)", async () => {
    const email = createNullEmail({ failures: [new Error(NEEDLE)] });
    const s = sender({ email });
    await expect(s.send.send(job)).rejects.toThrow();
    expect(await s.send.send(job)).toBe("sent");
    expect(s.mints).toHaveLength(2);
    expect(s.mints[0]?.hash.equals(s.mints[1]?.hash ?? Buffer.alloc(0))).toBe(
      false,
    );
  });

  test("invitationEmail: en and ar render; an unknown zone falls back to UTC; an unsupported language to en", () => {
    const en = invitationEmail(
      { language: "en", timezone: "Africa/Lagos" },
      "https://x.example/invite#t",
      EXPIRES,
    );
    expect(en.locale).toBe("en");
    expect(en.text).toContain("https://x.example/invite#t");
    expect(en.text).toContain("November 13, 2026 at 1:00 PM");
    const ar = invitationEmail(
      { language: "ar", timezone: "Asia/Dubai" },
      "https://x.example/invite#t",
      EXPIRES,
    );
    expect(ar.locale).toBe("ar");
    const odd = invitationEmail(
      { language: "sw", timezone: "Nowhere/Never" },
      "https://x.example/invite#t",
      EXPIRES,
    );
    expect(odd.locale).toBe("en");
    expect(odd.text).toContain("UTC");
  });
});

describe("activate (D6)", () => {
  function provisioner() {
    const calls: { email: string; lifespan: number }[] = [];
    return {
      calls,
      ensureInvitedAccount(email: string, lifespan: number) {
        calls.push({ email, lifespan });
        return Promise.resolve("created" as const);
      },
    };
  }

  test("a pending invitation: read in the org as the inviter, then Keycloak with the link's life until the invitation ends", async () => {
    const database = fakeDatabase();
    const accounts = provisioner();
    const activator = createInvitationActivator({
      database,
      clock: { now: () => NOW },
      accounts,
      read: () => Promise.resolve({ email: ADDRESS, expiresAt: EXPIRES }),
    });
    expect(
      await activator.activate({
        invitationId: INV,
        orgId: ORG,
        invitedBy: INVITER,
      }),
    ).toBe("created");
    expect(database.contexts).toEqual([
      { orgId: ORG, userId: INVITER, projectIds: [] },
    ]);
    expect(accounts.calls).toEqual([{ email: ADDRESS, lifespan: 259_200 }]);
  });

  test("a settled invitation touches no account", async () => {
    const accounts = provisioner();
    const activator = createInvitationActivator({
      database: fakeDatabase(),
      clock: { now: () => NOW },
      accounts,
      read: () => Promise.resolve(undefined),
    });
    expect(
      await activator.activate({
        invitationId: INV,
        orgId: ORG,
        invitedBy: INVITER,
      }),
    ).toBe("settled");
    expect(accounts.calls).toEqual([]);
  });

  test("the action link lives 1 h to 7 d", () => {
    expect(actionLinkSeconds("2026-11-10T12:10:00.000Z", NOW)).toBe(
      ACTION_LINK_MIN_SECONDS,
    );
    expect(actionLinkSeconds("2027-01-01T00:00:00.000Z", NOW)).toBe(
      ACTION_LINK_MAX_SECONDS,
    );
    expect(actionLinkSeconds("not a date", NOW)).toBe(ACTION_LINK_MIN_SECONDS);
  });
});

describe("the Keycloak provisioner (D6, C2)", () => {
  function api(users: Record<string, unknown>[]) {
    const calls: unknown[][] = [];
    const fake: AccountApi = {
      findByEmail(email) {
        calls.push(["find", email]);
        return Promise.resolve(users);
      },
      create(email, actions) {
        calls.push(["create", email, [...actions]]);
        return Promise.resolve("kc-new");
      },
      sendActions(id, actions, lifespan) {
        calls.push(["send", id, [...actions], lifespan]);
        return Promise.resolve();
      },
    };
    return { fake, calls };
  }

  test("no account: created unverified with VERIFY_EMAIL and UPDATE_PASSWORD, and those actions e-mailed", async () => {
    const { fake, calls } = api([
      // A look-alike the exact search should not return; filtered anyway.
      { id: "kc-other", email: `x${ADDRESS}` },
    ]);
    let tokens = 0;
    const p = accountProvisionerOver(fake, () => {
      tokens += 1;
      return Promise.resolve();
    });
    expect(await p.ensureInvitedAccount(ADDRESS, 3600)).toBe("created");
    expect(tokens).toBe(1);
    expect(NEW_ACCOUNT_ACTIONS).toEqual(["VERIFY_EMAIL", "UPDATE_PASSWORD"]);
    expect(calls).toEqual([
      ["find", ADDRESS],
      ["create", ADDRESS, ["VERIFY_EMAIL", "UPDATE_PASSWORD"]],
      ["send", "kc-new", ["VERIFY_EMAIL", "UPDATE_PASSWORD"], 3600],
    ]);
  });

  test("an unverified account: its pending actions again, VERIFY_EMAIL at least, nothing else ever", async () => {
    const { fake, calls } = api([
      {
        id: "kc-1",
        email: ADDRESS.toUpperCase(),
        emailVerified: false,
        enabled: true,
        requiredActions: ["UPDATE_PASSWORD", "CONFIGURE_TOTP"],
      },
    ]);
    expect(
      await accountProvisionerOver(fake).ensureInvitedAccount(ADDRESS, 7200),
    ).toBe("actions_sent");
    expect(calls.at(-1)).toEqual([
      "send",
      "kc-1",
      ["VERIFY_EMAIL", "UPDATE_PASSWORD"],
      7200,
    ]);
  });

  test("a verified or a disabled account: nothing sent", async () => {
    for (const [user, outcome] of [
      [{ id: "kc-1", email: ADDRESS, emailVerified: true }, "verified"],
      [{ id: "kc-1", email: ADDRESS, enabled: false }, "disabled"],
    ] as const) {
      const { fake, calls } = api([user]);
      expect(
        await accountProvisionerOver(fake).ensureInvitedAccount(ADDRESS, 3600),
      ).toBe(outcome);
      expect(calls).toEqual([["find", ADDRESS]]);
    }
  });

  test("two accounts with the address (the realm forbids it): throws, nothing sent", async () => {
    const { fake, calls } = api([
      { id: "kc-1", email: ADDRESS },
      { id: "kc-2", email: ADDRESS },
    ]);
    await expect(
      accountProvisionerOver(fake).ensureInvitedAccount(ADDRESS, 3600),
    ).rejects.toThrow();
    expect(calls).toEqual([["find", ADDRESS]]);
  });
});

describe("the consumer", () => {
  function deps(over: Partial<InvitationDeps> = {}) {
    const log = recorder();
    const seen: unknown[] = [];
    const d: InvitationDeps = {
      sender: {
        send: (job) => {
          seen.push(["send", job]);
          return Promise.resolve("sent");
        },
      },
      activator: {
        activate: (job) => {
          seen.push(["activate", job]);
          return Promise.resolve("created");
        },
      },
      expirer: {
        expire: (ref, correlation) => {
          seen.push(["expire", ref.id, correlation]);
          return Promise.resolve({
            id: ref.id,
            projectId: null,
            status: "expired",
            revokeReason: null,
          });
        },
      },
      due: { read: () => Promise.resolve([]) },
      logger: log,
      ...over,
    };
    return { d, log, seen };
  }

  test("send: one invitation.sent line with ids and the send number only", async () => {
    const { d, log, seen } = deps();
    await processInvitationJob(sendJob(), d);
    expect(seen).toEqual([
      [
        "send",
        { invitationId: INV, sendSeq: 1, invitedBy: INVITER, orgId: ORG },
      ],
    ]);
    expect(log.lines).toEqual([
      {
        level: "info",
        msg: "invitation.sent",
        fields: { outboxId: OUTBOX, invitationId: INV, sendSeq: 1, attempt: 1 },
      },
    ]);
  });

  test("a stale send: invitation.send_stale", async () => {
    const { d, log } = deps({
      sender: { send: () => Promise.resolve("stale") },
    });
    await processInvitationJob(sendJob(), d);
    expect(log.lines.map((l) => l.msg)).toEqual(["invitation.send_stale"]);
  });

  test("activate: one invitation.activated line with the outcome", async () => {
    const { d, log } = deps();
    await processInvitationJob(activateJob(), d);
    expect(log.lines).toEqual([
      {
        level: "info",
        msg: "invitation.activated",
        fields: { outboxId: OUTBOX, invitationId: INV, outcome: "created" },
      },
    ]);
  });

  test("the sweep: each due row in its own org with sweep.<id>; goes on past a failure, then fails", async () => {
    const due: InvitationRef[] = [
      { id: INV, orgId: ORG, invitedBy: INVITER },
      { id: INV_B, orgId: ORG, invitedBy: INVITER },
    ];
    const seen: string[] = [];
    const { d, log } = deps({
      due: { read: (limit) => (expect(limit).toBe(100), Promise.resolve(due)) },
      expirer: {
        expire: (ref, correlation) => {
          seen.push(correlation);
          return ref.id === INV
            ? Promise.reject(new Error(NEEDLE))
            : Promise.resolve(undefined as SettledInvitation | undefined);
        },
      },
    });
    await expect(
      processInvitationJob(
        { name: INVITATIONS_SWEEP, data: {}, attemptsMade: 0, opts: {} },
        d,
      ),
    ).rejects.toThrow("invitation sweep: 1 failed");
    expect(seen).toEqual([`sweep.${INV}`, `sweep.${INV_B}`]);
    expect(log.lines).toEqual([
      {
        level: "info",
        msg: "invitation.sweep",
        fields: { due: 2, expired: 0, skipped: 1, failed: 1 },
      },
    ]);
    expect(allText(log.lines)).not.toContain(NEEDLE);
  });

  test("failures: rejected, retry and the last failure carry ids, status and codes, never a message", () => {
    const log = recorder();
    onInvitationFailed(sendJob(), new UnrecoverableError(NEEDLE), log);
    onInvitationFailed(
      { ...sendJob(), attemptsMade: 3 },
      Object.assign(new Error(NEEDLE), { response: { status: 500 } }),
      log,
    );
    onInvitationFailed(
      { ...sendJob(), attemptsMade: 40 },
      new EmailUnavailableError(),
      log,
    );
    onInvitationFailed(
      { ...sendJob(), attemptsMade: 40 },
      Object.assign(new Error("x"), { code: NEEDLE }),
      log,
    );
    onInvitationFailed(
      { name: INVITATIONS_SWEEP, data: {}, attemptsMade: 2, opts: {} },
      new Error(NEEDLE),
      log,
    );
    expect(log.lines.map((l) => [l.level, l.msg])).toEqual([
      ["error", "invitation.rejected"],
      ["debug", "invitation.retry"],
      ["error", "invitation.failed"],
      ["error", "invitation.failed"],
      ["error", "invitation.sweep_failed"],
    ]);
    expect(log.lines[1]?.fields).toMatchObject({
      invitationId: INV,
      status: 500,
      attempt: 3,
    });
    expect(log.lines[2]?.fields).toMatchObject({
      code: "invitation.email_unavailable",
    });
    expect(log.lines[3]?.fields.code).toBeUndefined();
    expect(allText(log.lines)).not.toContain(NEEDLE);
    expect(allText(log.lines)).not.toContain(ADDRESS);
  });
});

describe("expiry (D10)", () => {
  test("changed: one withTx() in the org as the inviter; the update, then org.invitation.expire as system with the correlation", async () => {
    const database = fakeDatabase();
    const order: unknown[] = [];
    const expirer = createInvitationExpirer({
      database,
      clock: { now: () => NOW },
      ids: { next: () => OUTBOX },
      statements: {
        expire: (_tx, id, now) => {
          order.push(["expire", id, now]);
          return Promise.resolve({
            id,
            projectId: null,
            status: "expired",
            revokeReason: null,
          });
        },
        record: (_tx, options, event, origin) => {
          order.push(["record", options.actor, event, origin]);
          return Promise.resolve({} as never);
        },
      },
    });
    await expirer.expire(
      { id: INV, orgId: ORG, invitedBy: INVITER },
      `sweep.${INV}`,
    );
    expect(database.contexts).toEqual([
      { orgId: ORG, userId: INVITER, projectIds: [] },
    ]);
    expect(order).toEqual([
      ["expire", INV, new Date(NOW).toISOString()],
      [
        "record",
        "system",
        {
          action: INVITATION_EXPIRE_ACTION,
          entityType: INVITATION_SUBJECT,
          entityId: INV,
          before: { status: "pending" },
          after: { status: "expired", projectId: null },
        },
        { correlationId: `sweep.${INV}` },
      ],
    ]);
    expect(INVITATION_EXPIRE_ACTION).toBe("org.invitation.expire");
  });

  test("not due or gone: no event", async () => {
    let recorded = 0;
    const expirer = createInvitationExpirer({
      database: fakeDatabase(),
      clock: { now: () => NOW },
      ids: { next: () => OUTBOX },
      statements: {
        expire: () => Promise.resolve(undefined),
        record: () => {
          recorded += 1;
          return Promise.resolve({} as never);
        },
      },
    });
    expect(
      await expirer.expire({ id: INV, orgId: ORG, invitedBy: INVITER }, "c"),
    ).toBeUndefined();
    expect(recorded).toBe(0);
  });

  test("the due reader refuses a limit outside 1..1000 before any transaction", async () => {
    let opened = 0;
    const reader = dueInvitationReader({
      withRelayTx: () => {
        opened += 1;
        return Promise.resolve([] as never);
      },
    });
    await expect(reader.read(0)).rejects.toThrow(RangeError);
    await expect(reader.read(1001)).rejects.toThrow(RangeError);
    expect(opened).toBe(0);
    await reader.read(100);
    expect(opened).toBe(1);
  });
});

describe("the e-mail adapter the worker sends with", () => {
  test("the first registered e-mail adapter; none in a list without one", () => {
    const email = createNullEmail();
    expect(emailAdapterOf([nullPayment, email])).toBe(email);
    expect(emailAdapterOf([nullPayment])).toBeUndefined();
    // A bare descriptor of kind email (no send) is not an adapter.
    expect(
      emailAdapterOf([{ ...nullPayment, id: "desc_email", kind: "email" }]),
    ).toBeUndefined();
  });
});
