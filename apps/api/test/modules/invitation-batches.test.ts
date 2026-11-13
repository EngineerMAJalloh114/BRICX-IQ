// The invitation-batches service without a database (P6-06c, ADR 0085):
// the submit over plain fakes (the batch lock first, 409 while another
// batch runs, the lazy purge of a stale one, the 24 h quota with refused
// rows counted, each row through ownerRoleRefusal then the single invite's
// checkRow, refused rows keep only their code, one outbox row and one
// audit event with counts only, the escalation denial after the commit),
// and the reads (404 for another org, the purge before the answer, row
// pages by number). End to end, against Postgres: invitation-batches.int.
import type { Tx } from "@bricx/db/database";
import { PinoLogger } from "nestjs-pino";
import { pino } from "pino";
import { describe, expect, test } from "vitest";
import {
  type Identity,
  runWithRequestContext,
  setIdentity,
} from "../../src/common/db/request-context.js";
import { ApiError } from "../../src/common/errors/api-error.js";
import type {
  BatchRowData,
  InvitationBatchData,
} from "../../src/modules/invitation-batches/invitation-batches.dto.js";
import {
  MAX_ROWS_PER_DAY,
  encodeRowCursor,
} from "../../src/modules/invitation-batches/invitation-batches.dto.js";
import { INVITATIONS_BULK } from "../../src/modules/invitation-batches/invitation-batches.events.js";
import type {
  InvitationBatchesRepository,
  NewBatchRow,
} from "../../src/modules/invitation-batches/invitation-batches.repository.js";
import { InvitationBatchesService } from "../../src/modules/invitation-batches/invitation-batches.service.js";
import type { RowVerdict } from "../../src/modules/invitations/public-api.js";
import { grantsOf } from "../support/auth.js";

const ORG = "0199e1a0-0000-7000-8000-00000000000a";
const USER = "0199e1a0-0000-7000-8000-000000000001";
const SESSION = "0199e1a0-0000-7000-8000-00000000005e";
const ROLE = "0199e1a0-0000-7000-8000-000000000101";
const OWNER_ROLE = "0199e1a0-0000-7000-8000-000000000100";
const PROJECT = "0199e1a0-0000-7000-8000-000000000010";
const PROJECT_ROLE = "0199e1a0-0000-7000-8000-000000000102";
const BATCH = "0199e1a0-0000-7000-8000-0000000000c1";
const NOW_MS = Date.UTC(2026, 10, 13, 12, 0, 0);
const NOW = new Date(NOW_MS).toISOString();
const HOUR = 3_600_000;
const NEEDLE = "needle-b7c2";

const identity: Identity = {
  orgId: ORG,
  userId: USER,
  projectIds: [],
  allProjects: true,
  grants: grantsOf({ roles: ["administrator"] }),
  membershipGrants: grantsOf({ roles: ["administrator"] }),
  sessionId: SESSION,
  deviceId: undefined,
  acr: "mfa",
};

const asIdentity = <T>(fn: () => Promise<T>) =>
  runWithRequestContext(
    { correlationId: "corr-1", ip: "127.0.0.1", deviceId: undefined },
    async () => {
      setIdentity(identity);
      return fn();
    },
  );

const batch = (
  over: Partial<InvitationBatchData> = {},
): InvitationBatchData => ({
  id: BATCH,
  status: "queued",
  createdBy: USER,
  rowCount: 2,
  createdCount: 0,
  failedCount: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const logger = () =>
  new PinoLogger<never>({ pinoHttp: { logger: pino({ level: "silent" }) } });

interface World {
  open?: InvitationBatchData | undefined;
  found?: InvitationBatchData | undefined;
  /** What find() answers after the purge (the batch now done). */
  afterPurge?: InvitationBatchData | undefined;
  used?: number;
  rows?: BatchRowData[];
  /** checkRow's answer for an address; undefined = the default pass. */
  verdict?: (email: string) => RowVerdict | undefined;
  /** finishBatch's answer: the counts row, or none (already done). */
  finished?: boolean;
}

function harness(world: World = {}) {
  const calls: string[] = [];
  const inserted: { rows: NewBatchRow[] }[] = [];
  const enqueued: { topic: string; payload: unknown }[] = [];
  const audits: { action: string; after?: unknown; system: boolean }[] = [];
  const denials: { reason: string; entityId?: string }[] = [];
  const executed: string[] = [];
  let finds = 0;
  const tx = {
    execute: (query: { queryChunks?: unknown[] }) => {
      const text = JSON.stringify(query.queryChunks ?? query);
      executed.push(text);
      if (text.includes("WITH counts")) {
        return Promise.resolve({
          rows:
            world.finished === false
              ? []
              : [{ created_count: 0, failed_count: 2 }],
          rowCount: world.finished === false ? 0 : 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 2 });
    },
  } as unknown as Tx;
  const runner = {
    run: <T>(fn: (t: Tx) => Promise<T>) => {
      calls.push("tx");
      return fn(tx);
    },
  };
  const repository = {
    lock: () => {
      calls.push("lock");
      return Promise.resolve();
    },
    open: () => {
      calls.push("open");
      return Promise.resolve(world.open);
    },
    find: (_tx: Tx, orgId: string) => {
      finds += 1;
      if (orgId !== ORG) return Promise.resolve(undefined);
      return Promise.resolve(
        finds > 1 && world.afterPurge !== undefined
          ? world.afterPurge
          : world.found,
      );
    },
    rowsSince: () => {
      calls.push("quota");
      return Promise.resolve(world.used ?? 0);
    },
    insert: (_tx: Tx, input: { rows: NewBatchRow[] }) => {
      calls.push("insert");
      inserted.push({ rows: input.rows });
      return Promise.resolve();
    },
    rows: (_tx: Tx, _org: string, _id: string, after: number, limit: number) =>
      Promise.resolve(
        (world.rows ?? []).filter((r) => r.rowNo > after).slice(0, limit),
      ),
  } as unknown as InvitationBatchesRepository;
  const roles = {
    findOpen: (_tx: Tx, _org: string, id: string) =>
      Promise.resolve({
        id,
        key: id === OWNER_ROLE ? "owner" : "member",
        name: "role",
        systemKey: id === OWNER_ROLE ? "owner" : null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
      }),
  };
  const checks: string[] = [];
  const pass = (projectId: string | undefined): RowVerdict => ({
    ok: true,
    role: { roleId: ROLE, keys: [], systemKey: null },
    project:
      projectId === undefined
        ? undefined
        : {
            id: projectId,
            role: { roleId: PROJECT_ROLE, keys: [], systemKey: null },
          },
    external: false,
    membershipExpiresAt: null,
  });
  const invitations = {
    checkRow: (
      _tx: Tx,
      _who: Identity,
      _ability: unknown,
      input: { email: string; projectId?: string },
    ): Promise<RowVerdict> => {
      checks.push(input.email);
      return Promise.resolve(
        world.verdict?.(input.email) ?? pass(input.projectId),
      );
    },
  };
  const service = new InvitationBatchesService(
    runner,
    repository,
    invitations as never,
    roles,
    {
      record: (_tx: Tx, e: { action: string; after?: unknown }) => {
        audits.push({ action: e.action, after: e.after, system: false });
        return Promise.resolve();
      },
      recordSystem: (_tx: Tx, e: { action: string; after?: unknown }) => {
        audits.push({ action: e.action, after: e.after, system: true });
        return Promise.resolve();
      },
    } as never,
    {
      enqueue: (_tx: Tx, topic: string, payload: unknown) => {
        enqueued.push({ topic, payload });
        return Promise.resolve();
      },
    } as never,
    {
      record: (d: { reason: string; entityId?: string }) => {
        calls.push("denial");
        denials.push(d);
        return Promise.resolve();
      },
    } as never,
    { now: () => NOW_MS },
    logger(),
  );
  return {
    service,
    calls,
    inserted,
    enqueued,
    audits,
    denials,
    checks,
    executed,
  };
}

async function apiError(work: () => Promise<unknown>): Promise<ApiError> {
  try {
    await work();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected an ApiError");
}

const row = (email: string, over: Record<string, unknown> = {}) => ({
  email,
  roleId: ROLE,
  ...over,
});

describe("submit", () => {
  test("every row is parsed, then the owner role, then the single invite's checks; refused rows keep only their code; one outbox row and one audit event with counts only", async () => {
    const h = harness({
      verdict: (email) =>
        email.startsWith("denied")
          ? { ok: false, code: "not_found" }
          : undefined,
    });
    const answer = await asIdentity(() =>
      h.service.submit({
        rows: [
          row(`ok-${NEEDLE}@example.test`),
          { email: "not an address", roleId: ROLE },
          row("owner@example.test", { roleId: OWNER_ROLE }),
          row("project-owner@example.test", {
            projectId: PROJECT,
            projectRoleId: OWNER_ROLE,
          }),
          row("denied@example.test"),
          row("project@example.test", {
            projectId: PROJECT,
            projectRoleId: PROJECT_ROLE,
          }),
        ],
      }),
    );
    expect(answer.batchId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect({ accepted: answer.accepted, failed: answer.failed }).toEqual({
      accepted: 2,
      failed: 4,
    });
    expect(Object.keys(answer).sort()).toEqual([
      "accepted",
      "batchId",
      "failed",
    ]);
    // The batch lock comes first, then the open batch, then the quota.
    expect(h.calls).toEqual(["tx", "lock", "open", "quota", "insert"]);
    // The owner rows never reach checkRow; the malformed one neither.
    expect(h.checks).toEqual([
      `ok-${NEEDLE}@example.test`,
      "denied@example.test",
      "project@example.test",
    ]);
    expect(h.inserted[0]?.rows).toEqual([
      {
        rowNo: 1,
        status: "pending",
        email: `ok-${NEEDLE}@example.test`,
        roleId: ROLE,
        projectId: null,
        projectRoleId: null,
        external: false,
        membershipExpiresAt: null,
      },
      { rowNo: 2, status: "failed", errorCode: "validation_failed" },
      { rowNo: 3, status: "failed", errorCode: "owner_role" },
      { rowNo: 4, status: "failed", errorCode: "owner_role" },
      { rowNo: 5, status: "failed", errorCode: "not_found" },
      {
        rowNo: 6,
        status: "pending",
        email: "project@example.test",
        roleId: ROLE,
        projectId: PROJECT,
        projectRoleId: PROJECT_ROLE,
        external: false,
        membershipExpiresAt: null,
      },
    ]);
    expect(h.enqueued).toEqual([
      {
        topic: INVITATIONS_BULK,
        payload: { batchId: answer.batchId, createdBy: USER },
      },
    ]);
    expect(h.audits).toEqual([
      {
        action: "org.invitation_batch.create",
        after: { rowCount: 6, accepted: 2, failed: 4 },
        system: false,
      },
    ]);
    expect(JSON.stringify([h.enqueued, h.audits])).not.toContain(NEEDLE);
    expect(h.denials).toEqual([]);
  });

  test("a row refused for escalation records one denial after the commit", async () => {
    const h = harness({
      verdict: () => ({ ok: false, code: "escalation" }),
    });
    const answer = await asIdentity(() =>
      h.service.submit({
        rows: [row("a@example.test"), row("b@example.test")],
      }),
    );
    expect(answer).toMatchObject({ accepted: 0, failed: 2 });
    expect(h.calls.at(-1)).toBe("denial");
    expect(h.denials).toEqual([
      expect.objectContaining({
        reason: "escalation",
        entityId: answer.batchId,
      }),
    ]);
  });

  test("another queued or running batch that is not stale is 409 invitation.bulk_running, nothing written", async () => {
    const h = harness({ open: batch({ createdAt: NOW }) });
    const error = await apiError(() =>
      asIdentity(() => h.service.submit({ rows: [row("a@example.test")] })),
    );
    expect(error.code).toBe("invitation.bulk_running");
    expect(h.calls).toEqual(["tx", "lock", "open"]);
    expect(h.audits).toEqual([]);
  });

  test("a stale open batch (an hour old) is purged first, audited as system once, and the submit goes on", async () => {
    const stale = batch({
      status: "running",
      createdAt: new Date(NOW_MS - HOUR).toISOString(),
    });
    const h = harness({
      open: stale,
      found: batch({ ...stale, status: "done", failedCount: 2 }),
    });
    const answer = await asIdentity(() =>
      h.service.submit({ rows: [row("a@example.test")] }),
    );
    expect(answer).toMatchObject({ accepted: 1, failed: 0 });
    expect(h.audits.map((a) => [a.action, a.system])).toEqual([
      ["org.invitation_batch.complete", true],
      ["org.invitation_batch.create", false],
    ]);
    expect(h.audits[0]?.after).toEqual({
      status: "done",
      created: 0,
      failed: 2,
    });
  });

  test("the quota counts every row of the last 24 h: exactly MAX_ROWS_PER_DAY passes, one more is 429 invitation.bulk_quota", async () => {
    const full = harness({ used: MAX_ROWS_PER_DAY - 1 });
    await asIdentity(() =>
      full.service.submit({ rows: [row("a@example.test")] }),
    );
    expect(full.calls).toContain("insert");
    const over = harness({ used: MAX_ROWS_PER_DAY - 1 });
    const error = await apiError(() =>
      asIdentity(() =>
        over.service.submit({
          rows: [row("a@example.test"), row("b@example.test")],
        }),
      ),
    );
    expect(error.code).toBe("invitation.bulk_quota");
    expect(over.calls).not.toContain("insert");
  });
});

describe("reads", () => {
  test("get: another org's or an unknown batch is 404", async () => {
    const h = harness({ found: undefined });
    expect(
      (await apiError(() => asIdentity(() => h.service.get(BATCH)))).code,
    ).toBe("not_found");
  });

  test("get: a live batch is answered as it is, nothing written", async () => {
    const live = batch({
      createdAt: new Date(NOW_MS - HOUR + 1).toISOString(),
    });
    const h = harness({ found: live });
    expect(await asIdentity(() => h.service.get(BATCH))).toEqual(live);
    expect(h.executed).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  test("get: a stale batch is purged first (pending rows not_processed, the batch done, one system event); a done batch is never purged", async () => {
    const stale = batch({ createdAt: new Date(NOW_MS - HOUR).toISOString() });
    const done = batch({ ...stale, status: "done", failedCount: 2 });
    const h = harness({ found: stale, afterPurge: done });
    expect(await asIdentity(() => h.service.get(BATCH))).toEqual(done);
    expect(h.executed).toHaveLength(2);
    expect(h.executed[0]).toContain("not_processed");
    expect(h.audits.map((a) => a.action)).toEqual([
      "org.invitation_batch.complete",
    ]);
    const settled = harness({ found: done });
    await asIdentity(() => settled.service.get(BATCH));
    expect(settled.executed).toEqual([]);
  });

  test("get: a purge that finds the batch already closed writes no event", async () => {
    const stale = batch({ createdAt: new Date(NOW_MS - HOUR).toISOString() });
    const h = harness({ found: stale, finished: false });
    await asIdentity(() => h.service.get(BATCH));
    expect(h.audits).toEqual([]);
  });

  test("rows: pages by row number with a cursor; the last page has no cursor; another org's batch is 404", async () => {
    const rows: BatchRowData[] = [1, 2, 3].map((rowNo) => ({
      rowNo,
      status: "failed",
      errorCode: "conflict",
      invitationId: null,
    }));
    const h = harness({ found: batch({ status: "done" }), rows });
    const first = await asIdentity(() => h.service.rows(BATCH, { limit: 2 }));
    expect(first.items.map((r) => r.rowNo)).toEqual([1, 2]);
    expect(first.nextCursor).toBe(encodeRowCursor(2));
    const last = await asIdentity(() =>
      h.service.rows(BATCH, {
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      }),
    );
    expect(last.items.map((r) => r.rowNo)).toEqual([3]);
    expect(last.nextCursor).toBeNull();
    const all = await asIdentity(() => h.service.rows(BATCH, {}));
    expect(all.items).toHaveLength(3);
    expect(all.nextCursor).toBeNull();
    const none = harness({ found: undefined });
    expect(
      (await apiError(() => asIdentity(() => none.service.rows(BATCH, {}))))
        .code,
    ).toBe("not_found");
  });
});
