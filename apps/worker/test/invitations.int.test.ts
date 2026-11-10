// P6-06 (ADR 0077, D4-D6, D10; owner conditions C2, C7), live: the
// invitations consumer against compose.yml's Postgres and Valkey and the
// real realm (bricx-worker's service account with manage-users and
// view-users only, C2), its SMTP pointed at a throwaway sink (SMTP is
// deployment config; the realm file sets none: ADR 0077 launch blocker).
// The relay is the real one; outbox rows are written as bricx_app, as the
// API does; invitation rows are seeded as the superuser in the API's
// INSERT shape. The e-mail adapter is the Null one with `capture` (the
// test reads the link) and one scripted failure.
// - send: a failing adapter is retried (invitation.retry, the error's
//   code only), never dropped; the next attempt mints a fresh token on
//   the current send: the row's token_hash is SHA-256 of the link's
//   secret, the link is <INVITE_LINK_BASE>/invite#<CELL_ID>.<secret>, in
//   the org's language and time zone.
// - a stale send (its send_seq behind the row's, S20) mints nothing.
// - the sweep: a pending invitation past expires_at is expired with ONE
//   org.invitation.expire event (actor system); a second sweep writes
//   nothing.
// - activate (D6): an address with no account gets one, unverified, with
//   VERIFY_EMAIL and UPDATE_PASSWORD, and one action e-mail through
//   Keycloak; again: the same account, the actions again (no second
//   account); once verified, nothing is sent; a settled invitation does
//   nothing.
// - no line of any consumer or the relay carries an address, a secret or
//   a token (row 7).
import { createHash } from "node:crypto";
import { type EmailMessage } from "@bricx/adapters/types";
import { createNullEmail } from "@bricx/adapters/email";
import { loadWorkerConfig } from "@bricx/config/worker";
import { seedOrganization } from "@bricx/db-bootstrap/fixtures";
import { waitFor } from "@bricx/db-bootstrap/stack";
import {
  type Database,
  type RelayDatabase,
  openDatabase,
  openRelayDatabase,
} from "@bricx/db/database";
import { insertOutbox } from "@bricx/db/outbox";
import { createUuidV7Generator } from "@bricx/ids/uuid-v7";
import {
  type Keycloak,
  type SmtpSink,
  startKeycloak,
  startSmtpSink,
} from "@bricx/keycloak-realm/testing";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createInvitationActivator } from "../src/invitations/activate.js";
import {
  INVITATIONS_SWEEP,
  type InvitationConsumer,
  type InvitationDeps,
  createInvitationConsumer,
  processInvitationJob,
} from "../src/invitations/consumer.js";
import { dueInvitationReader } from "../src/invitations/due.js";
import { createInvitationExpirer } from "../src/invitations/expiry.js";
import { createInvitationSender } from "../src/invitations/send.js";
import { type Publisher, createBullPublisher } from "../src/relay/publisher.js";
import {
  type Relay,
  type RelayLogger,
  createRelay,
} from "../src/relay/relay.js";
import { outboxStore } from "../src/relay/store.js";
import { openConsumerValkey, openValkey } from "../src/relay/valkey.js";
import {
  type KeycloakAdmin,
  createKeycloakSessionEnder,
} from "../src/revocation/keycloak.js";
import { workerEnv } from "./env.js";
import { type Stack, startStack } from "./stack.js";

const HOOK_MS = 600_000;
const ORG = "0199e1a0-0000-7000-8000-0000000007a1";
const INVITER = "0199e1a0-0000-7000-8000-000000000701";
const ids = createUuidV7Generator({ clock: { now: () => Date.now() } });

interface Logged {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  fields: Record<string, unknown>;
}
function recorder(): RelayLogger & { lines: Logged[] } {
  const lines: Logged[] = [];
  const at =
    (level: Logged["level"]) =>
    (fields: Record<string, unknown>, msg: string) => {
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

let stack: Stack;
let keycloak: Keycloak;
let sink: SmtpSink;
let app: Database;
let relayDb: RelayDatabase;
let valkey: Redis;
let consumerValkey: Redis;
let publisher: Publisher;
let relay: Relay;
let accounts: KeycloakAdmin;
let consumer: InvitationConsumer;
let role: string;
const relayLog = recorder();
const log = recorder();
const captured: EmailMessage[] = [];
/** Every address, secret and token the suite used: none may be logged. */
const secrets = new Set<string>();
let deps: InvitationDeps;

async function asAdmin<T extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await stack.postgres.admin();
  try {
    return (await client.query<T>(text, params)).rows;
  } finally {
    await client.end();
  }
}

function config() {
  return loadWorkerConfig(
    workerEnv({
      DATABASE_URL: stack.url("bricx_app"),
      RELAY_DATABASE_URL: stack.url("bricx_relay"),
      VALKEY_URL: stack.valkeyUrl(),
      KEYCLOAK_ISSUER: `${keycloak.base}/realms/bricx`,
    }),
  );
}

beforeAll(async () => {
  sink = await startSmtpSink();
  [stack, keycloak] = await Promise.all([
    startStack(),
    startKeycloak(undefined, [
      { host: "host.docker.internal", ipAddress: "host-gateway" },
    ]),
  ]);
  // SMTP is deployment config (P13-01; ADR 0077 launch blocker). Test-only.
  await keycloak.admin("PUT", "", {
    smtpServer: {
      host: "host.docker.internal",
      port: String(sink.port),
      from: "keycloak@example.test",
    },
  });
  app = openDatabase({ reveal: () => stack.url("bricx_app") });
  relayDb = openRelayDatabase({ reveal: () => stack.url("bricx_relay") });
  valkey = openValkey({ reveal: () => stack.valkeyUrl() });
  await valkey.connect();
  consumerValkey = openConsumerValkey({ reveal: () => stack.valkeyUrl() });
  publisher = createBullPublisher(valkey);
  relay = createRelay({
    database: relayDb,
    store: outboxStore,
    publisher,
    logger: relayLog,
  });
  relay.start();
  const cfg = config();
  accounts = createKeycloakSessionEnder(cfg.keycloak);
  await seedOrganization(asAdmin, ORG);
  // The org's language and zone, for the message (fr, Africa/Freetown).
  await asAdmin(
    "UPDATE bricx.organizations SET default_language = 'fr', timezone = 'Africa/Freetown' WHERE id = $1",
    [ORG],
  );
  await asAdmin(
    `INSERT INTO bricx.users (id, keycloak_sub, created_at, last_seen_at)
     VALUES ($1, 'inviter-subject-7c1e', now(), now())`,
    [INVITER],
  );
  role = ids.next();
  await asAdmin(
    `INSERT INTO bricx.roles (id, org_id, key, name, created_at, updated_at)
     VALUES ($1, $2, 'crew', 'crew', now(), now())`,
    [role, ORG],
  );
  const clock = { now: () => Date.now() };
  deps = {
    sender: createInvitationSender({
      database: app,
      clock,
      email: createNullEmail({
        capture: (message) => captured.push(message),
        failures: [
          Object.assign(new Error("smtp down"), { code: "smtp_down" }),
        ],
      }),
      linkBase: cfg.invitations.linkBase,
      cellId: cfg.cellId,
    }),
    activator: createInvitationActivator({ database: app, clock, accounts }),
    expirer: createInvitationExpirer({ database: app, clock, ids }),
    due: dueInvitationReader(relayDb),
    logger: log,
  };
  consumer = createInvitationConsumer({ connection: consumerValkey, deps });
}, HOOK_MS);

afterAll(async () => {
  await consumer.close();
  await relay.stop();
  await publisher.close();
  valkey.disconnect();
  consumerValkey.disconnect();
  await relayDb.close();
  await app.close();
  await Promise.all([stack.stop(), keycloak.container.stop()]);
  await sink.close();
}, HOOK_MS);

let addresses = 0;
const newAddress = () => {
  addresses += 1;
  const address = `crew-${String(addresses)}@builders.example`;
  secrets.add(address);
  return address;
};

/** An invitation row in the API's INSERT shape; `expiresAt` an SQL expression. */
async function seedInvitation(
  email: string,
  options: { sendSeq?: number; expiresIn?: string; status?: string } = {},
): Promise<string> {
  const id = ids.next();
  await asAdmin(
    `INSERT INTO bricx.invitations
       (id, org_id, email_normalised, role_id, send_seq, resend_count,
        expires_at, invited_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5 - 1, now() + $6::interval, $7,
             now() - interval '2 hours', now() - interval '2 hours')`,
    [
      id,
      ORG,
      email,
      role,
      options.sendSeq ?? 1,
      options.expiresIn ?? "72 hours",
      INVITER,
    ],
  );
  return id;
}

async function enqueue(topic: string, payload: unknown): Promise<string> {
  const outboxId = ids.next();
  await app.withTx({ orgId: ORG, userId: INVITER, projectIds: [] }, (tx) =>
    insertOutbox(tx, topic, payload, outboxId),
  );
  return outboxId;
}

const rowOf = async (id: string) =>
  (
    await asAdmin<{
      status: string;
      token_hash: Buffer | null;
      last_sent_at: Date | null;
    }>(
      "SELECT status, token_hash, last_sent_at FROM bricx.invitations WHERE id = $1",
      [id],
    )
  )[0];

/** Waits until `check` holds (polling), or fails the test after `ms`. */
const until = (check: () => boolean, ms: number) =>
  waitFor("condition", () => Promise.resolve(check() ? true : undefined), ms);

const linesFor = (msg: string, outboxId?: string) =>
  log.lines.filter(
    (l) =>
      l.msg === msg &&
      (outboxId === undefined || l.fields.outboxId === outboxId),
  );

describe("invitations.send (D4, D5)", () => {
  test("a failing adapter is retried, never dropped; the retry mints on the current send: token_hash = SHA-256 of the link's secret; the link and the message", async () => {
    const email = newAddress();
    const id = await seedInvitation(email);
    const outboxId = await enqueue("invitations.send", {
      invitationId: id,
      sendSeq: 1,
      invitedBy: INVITER,
    });
    await until(
      () => linesFor("invitation.sent", outboxId).length === 1,
      60_000,
    );
    const [retry] = linesFor("invitation.retry", outboxId);
    expect(retry?.fields).toMatchObject({
      code: "smtp_down",
      invitationId: id,
    });
    const message = captured.find((m) => m.to === email);
    expect(message?.locale).toBe("fr");
    const link = /https?:\/\/\S+\/invite#(\S+)/.exec(message?.text ?? "");
    const token = link?.[1] ?? "";
    secrets.add(token);
    const [cell, secret] = token.split(".");
    expect(cell).toBe(config().cellId);
    expect(
      link?.[0].startsWith(`${config().invitations.linkBase}/invite#`),
    ).toBe(true);
    secrets.add(secret ?? "");
    const row = await rowOf(id);
    expect(row?.token_hash).toEqual(
      createHash("sha256")
        .update(Buffer.from(secret ?? "", "base64url"))
        .digest(),
    );
    expect(row?.last_sent_at).not.toBeNull();
    // Africa/Freetown is UTC+0: the end is named in French.
    expect(message?.text).toMatch(/\d{4}/);
  });

  test("a stale send (send_seq behind the row's, S20) mints nothing and completes", async () => {
    const id = await seedInvitation(newAddress(), { sendSeq: 2 });
    const outboxId = await enqueue("invitations.send", {
      invitationId: id,
      sendSeq: 1,
      invitedBy: INVITER,
    });
    await until(
      () => linesFor("invitation.send_stale", outboxId).length === 1,
      60_000,
    );
    expect((await rowOf(id))?.token_hash).toBeNull();
    expect(linesFor("invitation.sent", outboxId)).toEqual([]);
  });
});

describe("the sweep (D10)", () => {
  test("a pending invitation past expires_at is expired with ONE org.invitation.expire event (actor system); a second sweep writes nothing", async () => {
    const id = await seedInvitation(newAddress(), { expiresIn: "-1 minute" });
    const sweep = {
      name: INVITATIONS_SWEEP,
      data: {},
      attemptsMade: 0,
      opts: {},
    };
    await processInvitationJob(sweep, deps);
    expect((await rowOf(id))?.status).toBe("expired");
    const events = () =>
      asAdmin<{ action: string; actor_type: string; actor_id: string | null }>(
        "SELECT action, actor_type, actor_id::text FROM bricx.audit_events WHERE entity_id = $1",
        [id],
      );
    expect(await events()).toEqual([
      { action: "org.invitation.expire", actor_type: "system", actor_id: null },
    ]);
    await processInvitationJob(sweep, deps);
    expect(await events()).toHaveLength(1);
  });
});

describe("invitations.activate (D6) over the real realm (C2)", () => {
  const usersByEmail = async (email: string) =>
    (await keycloak.admin(
      "GET",
      `/users?email=${encodeURIComponent(email)}&exact=true`,
    )) as {
      id: string;
      emailVerified: boolean;
      requiredActions: string[];
    }[];

  test("no account: one is created, unverified, with VERIFY_EMAIL and UPDATE_PASSWORD, and one action e-mail; again: the same account and the actions again; once verified: nothing sent", async () => {
    const email = newAddress();
    const id = await seedInvitation(email);
    const activate = async () => {
      const outboxId = await enqueue("invitations.activate", {
        invitationId: id,
        invitedBy: INVITER,
      });
      await until(
        () => linesFor("invitation.activated", outboxId).length === 1,
        60_000,
      );
      return linesFor("invitation.activated", outboxId)[0]?.fields.outcome;
    };
    const sentTo = () =>
      sink.messages.filter((m) => m.toLowerCase().includes(email)).length;
    expect(await activate()).toBe("created");
    const [created] = await usersByEmail(email);
    expect(created?.emailVerified).toBe(false);
    expect([...(created?.requiredActions ?? [])].sort()).toEqual([
      "UPDATE_PASSWORD",
      "VERIFY_EMAIL",
    ]);
    await until(() => sentTo() === 1, 30_000);
    expect(await activate()).toBe("actions_sent");
    expect(await usersByEmail(email)).toHaveLength(1);
    await until(() => sentTo() === 2, 30_000);
    await keycloak.admin("PUT", `/users/${created?.id ?? ""}`, {
      emailVerified: true,
      requiredActions: [],
    });
    expect(await activate()).toBe("verified");
    expect(sentTo()).toBe(2);
  });

  test("a settled invitation does nothing (no account)", async () => {
    const email = newAddress();
    const id = await seedInvitation(email, { expiresIn: "-1 minute" });
    const outboxId = await enqueue("invitations.activate", {
      invitationId: id,
      invitedBy: INVITER,
    });
    await until(
      () => linesFor("invitation.activated", outboxId).length === 1,
      60_000,
    );
    expect(linesFor("invitation.activated", outboxId)[0]?.fields.outcome).toBe(
      "settled",
    );
    expect(await usersByEmail(email)).toEqual([]);
  });
});

describe("row 7: nothing logged carries an address, a secret or a token", () => {
  test("the consumer's and the relay's lines", () => {
    const text = JSON.stringify([...log.lines, ...relayLog.lines]);
    for (const value of secrets) {
      if (value.length > 0) expect(text).not.toContain(value);
    }
    expect(log.lines.length).toBeGreaterThan(0);
  });
});
