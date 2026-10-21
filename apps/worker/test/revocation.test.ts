// The sessions.revoked consumer (P5-04, ADR 0065; plan decisions 4, 5, 8
// and 10, owner conditions 1 and 3), over fakes: the payload is checked
// before anything runs (a bad one is unrecoverable: no retry), the
// org-scoped keys are set from the PAYLOAD's organisation (never the
// job's) with the TTL, the user key only for an administrator's revoke,
// the keys before the Keycloak call (a Keycloak failure leaves them set),
// then one revocation.applied line with ids only; a failure exhausts into
// one revocation.keycloak_failed line (session id, attempts, HTTP status),
// never a message or the sid. The backoff strategy resolves the topic's
// delivery options. Live, against Keycloak and Valkey: revocation.int.test.ts.
import { OUTBOX_TOPICS, deliveryBackoffMs } from "@bricx/db/outbox";
import { UnrecoverableError } from "bullmq";
import { describe, expect, test } from "vitest";
import { issuerParts } from "../src/revocation/keycloak.js";
import {
  type RevocationJob,
  type RevocationPayload,
  onRevocationFailed,
  outboxBackoff,
  parseRevocation,
  processRevocation,
  revocationKeyNames,
} from "../src/revocation/consumer.js";

const ORG_A = "0199e1a0-0000-7000-8000-00000000000a";
const ORG_B = "0199e1a0-0000-7000-8000-00000000000b";
const USER = "0199e1a0-0000-7000-8000-000000000001";
const SESSION = "0199e1a0-0000-7000-8000-0000000000a6";
const OUTBOX = "0199e1a0-0000-7000-8000-0000000000e1";
const SID = "sid-sentinel-3b7e-personal";
const SECRET = "secret-sentinel-5c1d-personal";

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

function fakes(options: { keycloakFails?: Error } = {}) {
  const calls: string[] = [];
  const keys = {
    set: (key: string, ttlSeconds: number) => {
      calls.push(`set:${key}:${String(ttlSeconds)}`);
      return Promise.resolve();
    },
  };
  const keycloak = {
    endSession: (sid: string) => {
      calls.push(`end:${sid}`);
      return options.keycloakFails === undefined
        ? Promise.resolve()
        : Promise.reject(options.keycloakFails);
    },
  };
  const logger = recorder();
  return { calls, keys, keycloak, logger, ttlSeconds: 330 };
}

const payload = (over: Record<string, unknown> = {}) => ({
  sessionId: SESSION,
  userId: USER,
  orgId: ORG_A,
  keycloakSid: SID,
  cause: "admin" as const,
  ...over,
});
/** A payload the consumer should accept, typed as it parses it. */
const accepted = (cause: "self" | "device" | "admin"): RevocationPayload => ({
  ...payload(),
  cause,
});

const job = (
  data: Record<string, unknown>,
  over: Partial<RevocationJob> = {},
): RevocationJob => ({
  name: "sessions.revoked",
  // The row's org (ORG_B) differs from the session's (payload: ORG_A).
  data: {
    outboxId: OUTBOX,
    orgId: ORG_B,
    topic: "sessions.revoked",
    payload: data,
  },
  attemptsMade: 0,
  opts: { attempts: 40 },
  ...over,
});

describe("issuerParts()", () => {
  test("splits the issuer into the admin client's base URL and realm", () => {
    expect(issuerParts("http://localhost:8080/realms/bricx")).toEqual({
      baseUrl: "http://localhost:8080",
      realm: "bricx",
    });
    expect(issuerParts("https://auth.example/auth/realms/prod-1")).toEqual({
      baseUrl: "https://auth.example/auth",
      realm: "prod-1",
    });
  });
});

describe("the keys", () => {
  test("revocationKeyNames(): org-scoped, the sid key for every cause and the user key only for admin", () => {
    expect(revocationKeyNames(accepted("self"))).toEqual([
      `revoked:sid:${ORG_A}:${SID}`,
    ]);
    expect(revocationKeyNames(accepted("device"))).toEqual([
      `revoked:sid:${ORG_A}:${SID}`,
    ]);
    expect(revocationKeyNames(accepted("admin"))).toEqual([
      `revoked:sid:${ORG_A}:${SID}`,
      `revoked:user:${ORG_A}:${USER}`,
    ]);
  });
});

describe("parseRevocation()", () => {
  test("accepts the registered payload", () => {
    expect(parseRevocation(job(payload()))).toEqual(payload());
  });

  test.each([
    ["another job name", job(payload(), { name: "sync.revoke" })],
    ["a missing field", job({ ...payload(), cause: undefined })],
    ["an unknown cause", job(payload({ cause: "root" }))],
    ["a non-string id", job(payload({ userId: 7 }))],
    ["an extra field", job(payload({ extra: 1 }))],
    ["a non-object payload", job({}, { data: { payload: "x" } })],
    ["no data", job({}, { data: undefined })],
  ])("%s is unrecoverable (no retry)", (_what, bad) => {
    expect(() => parseRevocation(bad)).toThrow(UnrecoverableError);
  });
});

describe("processRevocation()", () => {
  test("admin: the sid key then the user key (the payload's org, the TTL), then Keycloak, then one revocation.applied line with ids only", async () => {
    const f = fakes();
    await processRevocation(job(payload()), f);
    expect(f.calls).toEqual([
      `set:revoked:sid:${ORG_A}:${SID}:330`,
      `set:revoked:user:${ORG_A}:${USER}:330`,
      `end:${SID}`,
    ]);
    expect(f.logger.lines).toEqual([
      {
        level: "info",
        msg: "revocation.applied",
        fields: {
          outboxId: OUTBOX,
          sessionId: SESSION,
          userId: USER,
          orgId: ORG_A,
          cause: "admin",
          attempt: 1,
        },
      },
    ]);
    expect(JSON.stringify(f.logger.lines)).not.toContain(SID);
    expect(JSON.stringify(f.logger.lines)).not.toContain(ORG_B);
  });

  test.each(["self", "device"] as const)(
    "%s: the sid key only, never the user key",
    async (cause) => {
      const f = fakes();
      await processRevocation(job(payload({ cause })), f);
      expect(f.calls).toEqual([
        `set:revoked:sid:${ORG_A}:${SID}:330`,
        `end:${SID}`,
      ]);
      expect(f.logger.lines[0]?.fields.cause).toBe(cause);
    },
  );

  test("a Keycloak failure: the keys are already set, the error propagates (BullMQ retries), nothing applied", async () => {
    const f = fakes({ keycloakFails: new Error(`boom ${SECRET}`) });
    await expect(processRevocation(job(payload()), f)).rejects.toThrow("boom");
    expect(f.calls).toEqual([
      `set:revoked:sid:${ORG_A}:${SID}:330`,
      `set:revoked:user:${ORG_A}:${USER}:330`,
      `end:${SID}`,
    ]);
    expect(f.logger.lines).toEqual([]);
  });

  test("a retry re-sets the keys first (attempt counted from attemptsMade)", async () => {
    const f = fakes();
    await processRevocation(job(payload(), { attemptsMade: 3 }), f);
    expect(f.calls[0]).toBe(`set:revoked:sid:${ORG_A}:${SID}:330`);
    expect(f.logger.lines[0]?.fields.attempt).toBe(4);
  });

  test("a bad payload: nothing set, nothing ended, unrecoverable", async () => {
    const f = fakes();
    await expect(
      processRevocation(job(payload({ cause: "root" })), f),
    ).rejects.toThrow(UnrecoverableError);
    expect(f.calls).toEqual([]);
  });
});

describe("onRevocationFailed()", () => {
  const withStatus = Object.assign(new Error(`HTTP ${SECRET}`), {
    response: { status: 502 },
  });

  test("attempts left: one debug revocation.retry line (session id, attempt, status)", () => {
    const logger = recorder();
    onRevocationFailed(job(payload(), { attemptsMade: 3 }), withStatus, logger);
    expect(logger.lines).toEqual([
      {
        level: "debug",
        msg: "revocation.retry",
        fields: {
          outboxId: OUTBOX,
          sessionId: SESSION,
          attempt: 3,
          status: 502,
        },
      },
    ]);
  });

  test("exhausted: one error revocation.keycloak_failed line (session id, attempts, status), never the message or the sid", () => {
    const logger = recorder();
    onRevocationFailed(
      job(payload(), { attemptsMade: 40 }),
      withStatus,
      logger,
    );
    expect(logger.lines).toEqual([
      {
        level: "error",
        msg: "revocation.keycloak_failed",
        fields: {
          outboxId: OUTBOX,
          sessionId: SESSION,
          attempts: 40,
          status: 502,
        },
      },
    ]);
    const text = JSON.stringify(logger.lines);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(SID);
  });

  test("an unrecoverable payload: revocation.rejected at error, once, with the outbox id only", () => {
    const logger = recorder();
    onRevocationFailed(
      job({ bad: true }, { attemptsMade: 1 }),
      new UnrecoverableError(`bad ${SECRET}`),
      logger,
    );
    expect(logger.lines).toEqual([
      {
        level: "error",
        msg: "revocation.rejected",
        fields: { outboxId: OUTBOX },
      },
    ]);
    expect(JSON.stringify(logger.lines)).not.toContain(SECRET);
  });

  test("no status on the error: status undefined; no job: outboxId undefined", () => {
    const logger = recorder();
    onRevocationFailed(undefined, new Error("x"), logger);
    expect(logger.lines[0]?.fields).toEqual({
      outboxId: undefined,
      sessionId: undefined,
      attempts: undefined,
      status: undefined,
    });
  });
});

describe("outboxBackoff()", () => {
  test("the outbox type resolves the topic's delivery options; anything else keeps BullMQ's delay", () => {
    const delivery = OUTBOX_TOPICS["sessions.revoked"]?.delivery;
    if (delivery === undefined) throw new Error("no delivery options");
    const j = job(payload(), {
      opts: { attempts: 40, backoff: { type: "outbox", delay: 1_000 } },
    });
    for (const n of [1, 2, 5, 7, 40]) {
      expect(outboxBackoff(n, "outbox", undefined, j)).toBe(
        deliveryBackoffMs(delivery, n),
      );
    }
    expect(outboxBackoff(7, "outbox", undefined, j)).toBe(60_000);
    expect(outboxBackoff(3, "other", undefined, j)).toBe(1_000);
    expect(outboxBackoff(3, "outbox", undefined, undefined)).toBe(1_000);
  });
});
