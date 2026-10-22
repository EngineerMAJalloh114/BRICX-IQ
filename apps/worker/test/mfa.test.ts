// The users.mfa_check consumer (P5-05, phase ruling D5, ADR 0066; plan
// 4.2, D-G), over fakes: the payload is checked before anything runs (a
// bad one is unrecoverable: no retry), the consumer reads the TRUTH
// (app.mfa_state() through the relay's transaction) and never a flag in
// the payload, then maps the realm role bricx-mfa: added when required and
// absent, removed when not required and present, nothing when already
// right; a user the database or Keycloak no longer knows logs
// mfa.user_missing and completes; one mfa.applied line with ids only; a
// failure exhausts into one mfa.keycloak_failed line (user id, attempts,
// HTTP status), never a message or the Keycloak subject. Live, against
// Keycloak, Postgres and Valkey: mfa.int.test.ts.
import { OUTBOX_TOPICS, deliveryBackoffMs } from "@bricx/db/outbox";
import { UnrecoverableError } from "bullmq";
import { describe, expect, test } from "vitest";
import {
  type MfaDeps,
  type MfaJob,
  USERS_MFA_CHECK,
  USERS_QUEUE,
  onMfaFailed,
  parseMfaCheck,
  processMfaCheck,
} from "../src/mfa/consumer.js";
import { mfaTruth } from "../src/mfa/truth.js";
import { outboxBackoff } from "../src/outbox-job.js";
import {
  MFA_ROLE,
  type RealmRoleApi,
  roleMapperOver,
} from "../src/revocation/keycloak.js";

const ORG_A = "0199e1a0-0000-7000-8000-00000000000a";
const USER = "0199e1a0-0000-7000-8000-000000000001";
const OUTBOX = "0199e1a0-0000-7000-8000-0000000000e1";
const SUB = "sub-sentinel-4a9c-personal";

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

interface FakeOptions {
  /** What the database answers: a state, undefined (no such user) or a failure. */
  state?: { keycloakSub: string; required: boolean } | undefined | Error;
  /** What Keycloak answers, or a failure. */
  outcome?: "added" | "removed" | "unchanged" | "user_missing" | Error;
}

function fakes(options: FakeOptions = {}): MfaDeps & {
  calls: string[];
  logger: ReturnType<typeof recorder>;
} {
  const calls: string[] = [];
  const state =
    "state" in options ? options.state : { keycloakSub: SUB, required: true };
  const outcome = options.outcome ?? "added";
  return {
    calls,
    truth: {
      read: (userId) => {
        calls.push(`read:${userId}`);
        return state instanceof Error
          ? Promise.reject(state)
          : Promise.resolve(state);
      },
    },
    keycloak: {
      ensureRealmRole: (sub, required) => {
        calls.push(`ensure:${sub}:${String(required)}`);
        return outcome instanceof Error
          ? Promise.reject(outcome)
          : Promise.resolve(outcome);
      },
    },
    logger: recorder(),
  };
}

const job = (
  payload: unknown = { userId: USER },
  over: Partial<MfaJob> = {},
): MfaJob => ({
  name: USERS_MFA_CHECK,
  data: { outboxId: OUTBOX, orgId: ORG_A, topic: USERS_MFA_CHECK, payload },
  attemptsMade: 0,
  opts: { attempts: 40 },
  ...over,
});

describe("the queue", () => {
  test("users.mfa_check is consumed from queue users, as the topic registers it", () => {
    expect(USERS_QUEUE).toBe("users");
    expect(OUTBOX_TOPICS["users.mfa_check"]?.queue).toBe(USERS_QUEUE);
  });
});

describe("parseMfaCheck()", () => {
  test("accepts the registered payload", () => {
    expect(parseMfaCheck(job())).toEqual({ userId: USER });
  });

  test.each([
    ["another job name", job({ userId: USER }, { name: "sessions.revoked" })],
    ["a missing field", job({})],
    ["an extra field", job({ userId: USER, required: true })],
    ["a non-string id", job({ userId: 7 })],
    ["an id that is no UUID", job({ userId: "not-a-uuid" })],
    ["a non-object payload", job("x")],
    ["no data", job(undefined, { data: undefined })],
  ])("%s is unrecoverable (no retry)", (_what, bad) => {
    expect(() => parseMfaCheck(bad)).toThrow(UnrecoverableError);
  });
});

describe("processMfaCheck()", () => {
  test("reads the truth, then maps the role from it, then one mfa.applied line with ids only (never the subject)", async () => {
    const f = fakes();
    await processMfaCheck(job(), f);
    expect(f.calls).toEqual([`read:${USER}`, `ensure:${SUB}:true`]);
    expect(f.logger.lines).toEqual([
      {
        level: "info",
        msg: "mfa.applied",
        fields: {
          outboxId: OUTBOX,
          userId: USER,
          required: true,
          changed: true,
          attempt: 1,
        },
      },
    ]);
    expect(JSON.stringify(f.logger.lines)).not.toContain(SUB);
  });

  test("not required: the role is cleared; an unchanged mapping logs changed false", async () => {
    const removed = fakes({
      state: { keycloakSub: SUB, required: false },
      outcome: "removed",
    });
    await processMfaCheck(job(), removed);
    expect(removed.calls).toEqual([`read:${USER}`, `ensure:${SUB}:false`]);
    expect(removed.logger.lines[0]?.fields).toMatchObject({
      required: false,
      changed: true,
    });
    const same = fakes({ outcome: "unchanged" });
    await processMfaCheck(job(undefined, { attemptsMade: 2 }), same);
    expect(same.logger.lines).toEqual([
      {
        level: "info",
        msg: "mfa.applied",
        fields: {
          outboxId: OUTBOX,
          userId: USER,
          required: true,
          changed: false,
          attempt: 3,
        },
      },
    ]);
  });

  test("the payload carries no flag: a required: false field is rejected, the truth decides", () => {
    expect(() => parseMfaCheck(job({ userId: USER, required: false }))).toThrow(
      UnrecoverableError,
    );
  });

  test("a user the database does not know: mfa.user_missing (database), Keycloak never called, the job completes", async () => {
    const f = fakes({ state: undefined });
    await expect(processMfaCheck(job(), f)).resolves.toBeUndefined();
    expect(f.calls).toEqual([`read:${USER}`]);
    expect(f.logger.lines).toEqual([
      {
        level: "warn",
        msg: "mfa.user_missing",
        fields: { outboxId: OUTBOX, userId: USER, where: "database" },
      },
    ]);
  });

  test("a user Keycloak does not know: mfa.user_missing (keycloak), the job completes", async () => {
    const f = fakes({ outcome: "user_missing" });
    await expect(processMfaCheck(job(), f)).resolves.toBeUndefined();
    expect(f.logger.lines).toEqual([
      {
        level: "warn",
        msg: "mfa.user_missing",
        fields: { outboxId: OUTBOX, userId: USER, where: "keycloak" },
      },
    ]);
  });

  test("a database failure rejects before Keycloak is reached; a Keycloak failure rejects with no applied line", async () => {
    const db = fakes({ state: new Error("db sentinel-1a2b-personal") });
    await expect(processMfaCheck(job(), db)).rejects.toThrow(
      "db sentinel-1a2b-personal",
    );
    expect(db.calls).toEqual([`read:${USER}`]);
    expect(db.logger.lines).toEqual([]);
    const kc = fakes({ outcome: new Error("kc sentinel-3c4d-personal") });
    await expect(processMfaCheck(job(), kc)).rejects.toThrow(
      "kc sentinel-3c4d-personal",
    );
    expect(kc.calls).toEqual([`read:${USER}`, `ensure:${SUB}:true`]);
    expect(kc.logger.lines).toEqual([]);
  });

  test("a bad payload rejects unrecoverably before the truth is read", async () => {
    const f = fakes();
    await expect(processMfaCheck(job({ userId: "nope" }), f)).rejects.toThrow(
      UnrecoverableError,
    );
    expect(f.calls).toEqual([]);
  });
});

describe("onMfaFailed()", () => {
  const failure = (status?: number) =>
    Object.assign(new Error("gateway sentinel-5e6f-personal"), {
      response: status === undefined ? undefined : { status },
    });

  test("a rejected payload: one mfa.rejected line", () => {
    const log = recorder();
    onMfaFailed(job(), new UnrecoverableError("bad"), log);
    expect(log.lines).toEqual([
      { level: "error", msg: "mfa.rejected", fields: { outboxId: OUTBOX } },
    ]);
  });

  test("a retry: one debug mfa.retry line with the attempt and status", () => {
    const log = recorder();
    onMfaFailed(job(undefined, { attemptsMade: 1 }), failure(502), log);
    expect(log.lines).toEqual([
      {
        level: "debug",
        msg: "mfa.retry",
        fields: { outboxId: OUTBOX, userId: USER, attempt: 1, status: 502 },
      },
    ]);
  });

  test("the last failure: one mfa.keycloak_failed line (user id, attempts, status), never the message", () => {
    const log = recorder();
    onMfaFailed(job(undefined, { attemptsMade: 40 }), failure(503), log);
    expect(log.lines).toEqual([
      {
        level: "error",
        msg: "mfa.keycloak_failed",
        fields: { outboxId: OUTBOX, userId: USER, attempts: 40, status: 503 },
      },
    ]);
    const noStatus = recorder();
    onMfaFailed(job(undefined, { attemptsMade: 40 }), failure(), noStatus);
    expect(noStatus.lines[0]?.fields).toEqual({
      outboxId: OUTBOX,
      userId: USER,
      attempts: 40,
      status: undefined,
    });
    expect(JSON.stringify([log.lines, noStatus.lines])).not.toContain(
      "sentinel-5e6f",
    );
  });

  test("a job without the relay's data logs no ids", () => {
    const log = recorder();
    onMfaFailed(undefined, failure(500), log);
    expect(log.lines).toEqual([
      {
        level: "error",
        msg: "mfa.keycloak_failed",
        fields: {
          outboxId: undefined,
          userId: undefined,
          attempts: undefined,
          status: 500,
        },
      },
    ]);
  });
});

describe("outboxBackoff() for users.mfa_check", () => {
  test("resolves the topic's delivery options (1 s doubling, 60 s cap)", () => {
    const delivery = OUTBOX_TOPICS["users.mfa_check"]?.delivery;
    if (delivery === undefined) throw new Error("no delivery options");
    for (const attempt of [1, 2, 6, 7, 40]) {
      expect(
        outboxBackoff(
          attempt,
          "outbox",
          undefined,
          job(undefined, {
            opts: { attempts: 40, backoff: { type: "outbox", delay: 1_000 } },
          }),
        ),
      ).toBe(deliveryBackoffMs(delivery, attempt));
    }
    expect(deliveryBackoffMs(delivery, 1)).toBe(1_000);
    expect(deliveryBackoffMs(delivery, 40)).toBe(60_000);
  });
});

describe("roleMapperOver()", () => {
  const OTHER = "offline_access";
  function api(options: {
    /** The user's mapped realm roles; undefined: no such user. */
    roles?: readonly string[] | undefined;
    /** Whether the realm offers bricx-mfa at all. */
    offered?: boolean;
  }) {
    const calls: string[] = [];
    let mapped: string[] | undefined =
      options.roles === undefined ? undefined : [...options.roles];
    const offered = options.offered ?? true;
    const listed = (names: readonly string[]) =>
      names.map((name) => ({ id: `${name}-id`, name }));
    const fake: RealmRoleApi = {
      listUserRoles: (sub) => {
        calls.push(`list:${sub}`);
        return Promise.resolve(
          mapped === undefined ? undefined : listed(mapped),
        );
      },
      listAvailableRoles: (sub) => {
        calls.push(`available:${sub}`);
        const all = offered ? [OTHER, MFA_ROLE] : [OTHER];
        return Promise.resolve(
          listed(all.filter((name) => !(mapped ?? []).includes(name))),
        );
      },
      addUserRole: (sub, added) => {
        calls.push(`add:${sub}:${added.id}`);
        mapped?.push(added.name);
        return Promise.resolve();
      },
      removeUserRole: (sub, removed) => {
        calls.push(`remove:${sub}:${removed.id}`);
        mapped = mapped?.filter((name) => name !== removed.name);
        return Promise.resolve();
      },
    };
    return { calls, fake, mapped: () => mapped };
  }

  test("required and absent: the role is added (its id from the available list); already right: no write", async () => {
    const a = api({ roles: [OTHER] });
    const before: string[] = [];
    const mapper = roleMapperOver(a.fake, () => {
      before.push("token");
      return Promise.resolve();
    });
    expect(await mapper.ensureRealmRole(SUB, true)).toBe("added");
    expect(a.calls).toEqual([
      `list:${SUB}`,
      `available:${SUB}`,
      `add:${SUB}:${MFA_ROLE}-id`,
    ]);
    expect(a.mapped()).toEqual([OTHER, MFA_ROLE]);
    expect(before).toEqual(["token"]);
    expect(await mapper.ensureRealmRole(SUB, true)).toBe("unchanged");
    expect(a.calls.slice(3)).toEqual([`list:${SUB}`]);
    expect(before).toEqual(["token", "token"]);
  });

  test("not required and present: the role is removed (its id from the mapped list); absent: nothing", async () => {
    const a = api({ roles: [MFA_ROLE, OTHER] });
    const mapper = roleMapperOver(a.fake);
    expect(await mapper.ensureRealmRole(SUB, false)).toBe("removed");
    expect(a.calls).toEqual([`list:${SUB}`, `remove:${SUB}:${MFA_ROLE}-id`]);
    expect(a.mapped()).toEqual([OTHER]);
    expect(await mapper.ensureRealmRole(SUB, false)).toBe("unchanged");
    expect(a.calls.slice(2)).toEqual([`list:${SUB}`]);
  });

  test("a subject Keycloak does not know: user_missing, no write", async () => {
    const a = api({ roles: undefined });
    const mapper = roleMapperOver(a.fake);
    expect(await mapper.ensureRealmRole(SUB, true)).toBe("user_missing");
    expect(a.calls).toEqual([`list:${SUB}`]);
  });

  test("the realm offers no bricx-mfa role: rejects (retried, then alerted), no write", async () => {
    const a = api({ roles: [], offered: false });
    const mapper = roleMapperOver(a.fake);
    await expect(mapper.ensureRealmRole(SUB, true)).rejects.toThrow(
      /realm role/,
    );
    expect(a.calls).toEqual([`list:${SUB}`, `available:${SUB}`]);
    // Not required: nothing to look up, nothing to write.
    expect(await mapper.ensureRealmRole(SUB, false)).toBe("unchanged");
    expect(a.calls.slice(2)).toEqual([`list:${SUB}`]);
  });
});

describe("mfaTruth()", () => {
  test("reads app.mfa_state(userId) inside the relay's transaction", async () => {
    const statements: string[] = [];
    const rows: { keycloak_sub: string; required: boolean }[] = [
      { keycloak_sub: SUB, required: true },
    ];
    let opened = 0;
    const database = {
      withRelayTx<T>(fn: (tx: never) => Promise<T>): Promise<T> {
        opened += 1;
        const tx = {
          execute: (query: { toSQL?: unknown; queryChunks?: unknown }) => {
            statements.push(JSON.stringify(query.queryChunks ?? query));
            return Promise.resolve({ rows });
          },
        };
        return fn(tx as never);
      },
    };
    const truth = mfaTruth(database);
    expect(await truth.read(USER)).toEqual({
      keycloakSub: SUB,
      required: true,
    });
    expect(opened).toBe(1);
    expect(statements[0]).toContain("app.mfa_state(");
    rows.length = 0;
    expect(await truth.read(USER)).toBeUndefined();
    expect(opened).toBe(2);
  });
});
