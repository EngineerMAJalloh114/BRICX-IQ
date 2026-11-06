// @bricx/db/organizations without a database (P6-02, ADR 0072; PD-2): the
// order of the writes createOrganization() and bootstrapOrganization() make
// in the caller's transaction, over a recording fake transaction, and the
// refusals (org_missing, org_not_empty, user_missing; any other error is
// rethrown). The rows themselves, RLS and the triggers are proven in
// organizations.int.test.ts against Postgres.
import { randomUUID } from "node:crypto";
import { ROLE_IDS, ROLES } from "@bricx/permissions/roles";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";
import type { Tx } from "../src/database.js";
import {
  BootstrapError,
  type NewOrganization,
  type OrganizationRow,
  bootstrapOrganization,
  createOrganization,
} from "../src/organizations.js";
import {
  auditEvents,
  memberships,
  organizations,
  rolePermissions,
  roles,
} from "../src/schema/tables.js";

const dialect = new PgDialect();
const ORG = "0199e1d0-0000-7000-8000-00000000000a";
const OWNER = "0199e1d0-0000-7000-8000-000000000001";
const NOW_MS = Date.UTC(2026, 10, 6, 12, 0, 0);
const NOW = new Date(NOW_MS).toISOString();

let n = 0;
const ids = {
  next: (): string => {
    n += 1;
    return `0199e1d0-${n.toString(16).padStart(4, "0")}-7000-8000-${randomUUID().slice(-12)}`;
  },
};
const deps = () => ({
  clock: { now: () => NOW_MS },
  ids,
  origin: { correlationId: ids.next() },
});

const row: OrganizationRow = {
  id: ORG,
  slug: "acme-build",
  legalName: "Acme Build Ltd",
  country: "SL",
  defaultCurrency: "SLE",
  defaultLanguage: "en",
  timezone: "Africa/Freetown",
  units: "metric",
  dataRegion: "af-south-1",
  brandColor: null,
  logoObjectKey: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
};

const input: NewOrganization = {
  id: ORG,
  slug: row.slug,
  legalName: row.legalName,
  country: row.country,
  defaultCurrency: row.defaultCurrency,
  defaultLanguage: row.defaultLanguage,
  timezone: row.timezone,
  units: "metric",
  dataRegion: row.dataRegion,
  brandColor: null,
  ownerId: OWNER,
  now: NOW,
};

const nameOf = (table: unknown): string => {
  if (table === organizations) return "organizations";
  if (table === memberships) return "memberships";
  if (table === roles) return "roles";
  if (table === rolePermissions) return "role_permissions";
  if (table === auditEvents) return "audit_events";
  return "?";
};

interface World {
  /** readOrganization() finds the row (default true). */
  readonly orgExists?: boolean;
  /** Membership rows already in the organisation (default 0). */
  readonly members?: number;
  /** The membership insert fails with this error. */
  readonly membershipError?: Error;
  /** The organisations insert returns no row. */
  readonly noReturning?: boolean;
}

/**
 * A transaction recording every call. One disclosed cast: a drizzle
 * transaction cannot be built without a connection.
 */
function fakeTx(world: World = {}) {
  const calls: string[] = [];
  const values: Record<string, unknown[]> = {};
  const tx = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const name = nameOf(table);
          calls.push(`select:${name}`);
          if (name === "organizations") {
            return Promise.resolve(world.orgExists === false ? [] : [row]);
          }
          return Promise.resolve([{ n: world.members ?? 0 }]);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (v: unknown) => {
        const name = nameOf(table);
        calls.push(`insert:${name}`);
        (values[name] ??= []).push(v);
        const done =
          name === "memberships" && world.membershipError !== undefined
            ? Promise.reject(world.membershipError)
            : Promise.resolve();
        return Object.assign(done, {
          returning: () =>
            Promise.resolve(world.noReturning === true ? [] : [row]),
        });
      },
    }),
    execute: (query: SQL) => {
      const text = dialect.sqlToQuery(query).sql;
      if (text.includes("current_user_id()")) {
        calls.push("audit:who");
        return Promise.resolve({ rows: [{ org: ORG, actor: OWNER }] });
      }
      if (text.includes("pg_advisory_xact_lock")) {
        calls.push("audit:lock");
        return Promise.resolve({ rows: [] });
      }
      if (text.includes("transaction_isolation")) {
        calls.push("audit:head");
        return Promise.resolve({
          rows: [
            { isolation: "read committed", seq: null, hash: null, ip: null },
          ],
        });
      }
      if (text.includes("app.current_org()::text AS org")) {
        calls.push("outbox:org");
        return Promise.resolve({ rows: [{ org: ORG }] });
      }
      if (text.includes("INSERT INTO bricx.outbox")) {
        calls.push("outbox:insert");
        return Promise.resolve({ rows: [] });
      }
      throw new Error("unexpected SQL");
    },
  } as unknown as Tx;
  const actions = () =>
    (values["audit_events"] ?? []).map(
      (v) => (v as { action?: unknown }).action,
    );
  return { tx, calls, values, actions };
}

const AUDIT = ["audit:who", "audit:lock", "audit:head", "insert:audit_events"];
const bundled = ROLE_IDS.filter((k) => k !== "owner" && ROLES[k].length > 0);

describe("createOrganization()", () => {
  test("the row, then the bootstrap (roles, owner, outbox, org.member.bootstrap), then org.organization.create, last", async () => {
    const f = fakeTx();
    const result = await createOrganization(f.tx, deps(), input);
    expect(result.organization).toEqual(row);
    expect(result.bootstrap.roles).toBe(ROLE_IDS.length);
    expect(f.calls[0]).toBe("insert:organizations");
    expect(f.calls.slice(1, 3)).toEqual([
      "select:organizations",
      "select:memberships",
    ]);
    expect(f.calls.filter((c) => c === "insert:roles")).toHaveLength(
      ROLE_IDS.length,
    );
    expect(f.calls.filter((c) => c === "insert:role_permissions")).toHaveLength(
      bundled.length,
    );
    const membership = f.calls.indexOf("insert:memberships");
    expect(f.calls.slice(membership)).toEqual([
      "insert:memberships",
      "outbox:org",
      "outbox:insert",
      ...AUDIT,
      ...AUDIT,
    ]);
    expect(f.actions()).toEqual([
      "org.member.bootstrap",
      "org.organization.create",
    ]);
    expect(f.values["organizations"]).toEqual([
      expect.objectContaining({
        id: ORG,
        dataRegion: "af-south-1",
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ]);
    expect(f.values["memberships"]).toEqual([
      expect.objectContaining({
        orgId: ORG,
        userId: OWNER,
        roleId: result.bootstrap.ownerRoleId,
      }),
    ]);
  });

  test("an insert that returns no row stops before the bootstrap", async () => {
    const f = fakeTx({ noReturning: true });
    await expect(createOrganization(f.tx, deps(), input)).rejects.toThrow(
      "insert returned no row",
    );
    expect(f.calls).toEqual(["insert:organizations"]);
  });
});

describe("bootstrapOrganization() refusals", () => {
  const boot = (world: World) => {
    const f = fakeTx(world);
    return {
      f,
      run: bootstrapOrganization(f.tx, deps(), {
        orgId: ORG,
        userId: OWNER,
        now: NOW,
      }),
    };
  };
  const reasonOf = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    if (!(error instanceof BootstrapError)) throw error;
    expect(error.name).toBe("BootstrapError");
    expect(error.message).not.toContain(ORG);
    expect(error.message).not.toContain(OWNER);
    return error.reason;
  };

  test("a missing organisation is org_missing, before any write", async () => {
    const { f, run } = boot({ orgExists: false });
    expect(await reasonOf(run)).toBe("org_missing");
    expect(f.calls).toEqual(["select:organizations"]);
  });

  test("an organisation with a membership row is org_not_empty, before any write", async () => {
    const { f, run } = boot({ members: 1 });
    expect(await reasonOf(run)).toBe("org_not_empty");
    expect(f.calls).toEqual(["select:organizations", "select:memberships"]);
  });

  test("the membership's user FK (23503) is user_missing; no outbox row or audit event follows", async () => {
    const { f, run } = boot({
      membershipError: Object.assign(new Error("fk"), { code: "23503" }),
    });
    expect(await reasonOf(run)).toBe("user_missing");
    expect(f.calls.at(-1)).toBe("insert:memberships");
  });

  test("any other error is rethrown as it is", async () => {
    const other = Object.assign(new Error("boom"), { code: "40001" });
    const { run } = boot({ membershipError: other });
    await expect(run).rejects.toBe(other);
  });
});
