// The organisations module without a database (P6-02, ADR 0072): the
// boundary schemas (the whole body validated before any transaction, C2)
// and the service over plain fakes: what create checks before Tx A, the
// attempt outcomes inside Tx A (key reused, refused replay, the cap), the
// directory refusals (slug_taken settles the attempt refused, anything
// else is 503 and leaves it pending) and archive's write and audit event.
// What needs a database (Tx B, read, update) is in
// organizations.int.test.ts.
import type { Tx } from "@bricx/db/database";
import {
  type DirectoryWriter,
  DirectoryRegistrationError,
} from "@bricx/db/directory";
import type { OrganizationRow } from "@bricx/db/organizations";
import { PinoLogger } from "nestjs-pino";
import { pino } from "pino";
import { describe, expect, test } from "vitest";
import { setSignedInUser } from "../../src/common/auth/signed-in.decorator.js";
import {
  NoTenantContextError,
  runWithRequestContext,
  setIdentity,
} from "../../src/common/db/request-context.js";
import { ApiError } from "../../src/common/errors/api-error.js";
import {
  CreateOrganizationSchema,
  UpdateOrganizationSchema,
} from "../../src/modules/organizations/organizations.dto.js";
import {
  type Attempt,
  OrganizationsRepository,
} from "../../src/modules/organizations/organizations.repository.js";
import {
  type OrganizationsAudit,
  OrganizationsService,
  type OrganizationsTxRunner,
} from "../../src/modules/organizations/organizations.service.js";

const USER = "0199e1a0-0000-7000-8000-000000000c01";
const ORG = "0199e1a0-0000-7000-8000-000000000c0a";
const EXISTING_ORG = "0199e1a0-0000-7000-8000-000000000c0b";
const NOW_MS = Date.UTC(2026, 10, 6, 12, 0, 0);
const NOW = new Date(NOW_MS).toISOString();
const KEY = "create-acme-1";
const CTX = {
  correlationId: "0199e1a0-0000-7000-8000-000000000ccc",
  ip: "127.0.0.1",
  deviceId: undefined,
};

const memberIdentity = {
  orgId: ORG,
  userId: USER,
  projectIds: [],
  allProjects: false,
  grants: [],
  membershipGrants: [],
  sessionId: "0199e1a0-0000-7000-8000-000000000c5e",
  deviceId: undefined,
  acr: "pwd",
} as const;

const body = {
  slug: "acme-build",
  legalName: "Acme Build Ltd",
  country: "SL",
  defaultCurrency: "SLE",
  defaultLanguage: "en",
  timezone: "Africa/Freetown",
};

const input = () => CreateOrganizationSchema.parse(body);

// The fake transaction handle: the fakes never use it (one disclosed
// cast; a drizzle transaction cannot be built without a connection).
const TX = {} as unknown as Tx;

const orgRow = (over: Partial<OrganizationRow> = {}): OrganizationRow => ({
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
  ...over,
});

interface World {
  readonly attempt?: Attempt;
  readonly counted?: number;
  readonly writer?: "none" | "ok" | DirectoryRegistrationError | Error;
  readonly updated?: OrganizationRow | undefined;
}

// One logger for the file: nestjs-pino keeps the first root logger.
const lines: string[] = [];
const logger = new PinoLogger<never>({
  pinoHttp: {
    logger: pino(
      { level: "warn" },
      { write: (line: string) => lines.push(line) },
    ),
  },
});

function fakes(world: World = {}) {
  const calls: string[] = [];
  lines.length = 0;
  const audits: {
    action: string;
    entityId?: string | undefined;
    after?: unknown;
  }[] = [];
  const settled: string[] = [];
  let inserted: { orgId: string; requestHash: Buffer } | undefined;
  const runner: OrganizationsTxRunner = {
    run: (fn) => {
      calls.push("tx");
      return fn(TX);
    },
    runSignedIn: (orgId, fn) => {
      calls.push(`tx-signed-in:${orgId === ORG ? "known" : "candidate"}`);
      return fn(TX);
    },
  };
  const audit: OrganizationsAudit = {
    record: (_tx, event) => {
      calls.push(`audit:${event.action}`);
      audits.push({
        action: event.action,
        entityId: event.entityId,
        after: event.after,
      });
      return Promise.resolve({ id: "x", seq: "1", hash: "h" });
    },
  };
  const repository = Object.assign(new OrganizationsRepository(), {
    lockUser: () => {
      calls.push("lock");
      return Promise.resolve();
    },
    findAttempt: () => {
      calls.push("find");
      return Promise.resolve(world.attempt);
    },
    countCounted: () => {
      calls.push("count");
      return Promise.resolve(world.counted ?? 0);
    },
    insertAttempt: (
      _tx: Tx,
      attempt: { readonly orgId: string; readonly requestHash: Buffer },
    ) => {
      calls.push("insert");
      inserted = { orgId: attempt.orgId, requestHash: attempt.requestHash };
      return Promise.resolve();
    },
    settleAttempt: (
      _tx: Tx,
      _user: string,
      _key: Buffer,
      state: "committed" | "refused",
    ) => {
      calls.push(`settle:${state}`);
      settled.push(state);
      return Promise.resolve();
    },
    update: (_tx: Tx, id: string, changes: Record<string, unknown>) => {
      calls.push(`update:${Object.keys(changes).sort().join(",")}`);
      return Promise.resolve(
        "updated" in world
          ? world.updated
          : orgRow({ id, archivedAt: NOW, updatedAt: NOW }),
      );
    },
  });
  const writerMode = world.writer ?? "ok";
  const registrations: { orgId: string; slug: string; cellId: string }[] = [];
  const writer: DirectoryWriter | undefined =
    writerMode === "none"
      ? undefined
      : {
          ping: () => Promise.resolve(),
          close: () => Promise.resolve(),
          registerOrganization: (registration) => {
            calls.push("register");
            registrations.push({ ...registration });
            return writerMode === "ok"
              ? Promise.resolve("reserved")
              : Promise.reject(writerMode);
          },
        };
  const service = new OrganizationsService(
    runner,
    repository,
    audit,
    { now: () => NOW_MS },
    "af-south-1",
    writer,
    2,
    logger,
    // P6-06 (ADR 0077, D14): the archive cascade (proved against Postgres
    // in invitations-edge.int.test.ts).
    () => Promise.resolve([]),
  );
  return {
    service,
    warnings: () =>
      lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    calls,
    audits,
    settled,
    registrations,
    inserted: () => inserted,
  };
}

const signedIn = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithRequestContext(CTX, () => {
    setSignedInUser({ userId: USER, acr: "pwd" });
    return fn();
  });

const member = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithRequestContext(CTX, () => {
    setIdentity(memberIdentity);
    return fn();
  });

const codeOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof ApiError)) throw error;
  return error.code;
};

describe("the boundary schemas (C2: the whole body before any transaction)", () => {
  test("a create takes the six fields, optional units and brand colour, nothing else", () => {
    expect(CreateOrganizationSchema.parse(body)).toEqual(body);
    expect(
      CreateOrganizationSchema.parse({
        ...body,
        units: "us_customary",
        brandColor: "#0a7c66",
      }),
    ).toMatchObject({ units: "us_customary", brandColor: "#0a7c66" });
    for (const bad of [
      { ...body, extra: 1 },
      { ...body, slug: "Acme" },
      { ...body, slug: "a" },
      { ...body, slug: "-acme" },
      { ...body, legalName: "" },
      { ...body, legalName: "x".repeat(201) },
      { ...body, country: "XX" },
      { ...body, defaultCurrency: "XYZ" },
      { ...body, defaultLanguage: "xx" },
      { ...body, timezone: "Mars/Olympus" },
      { ...body, units: "imperial" },
      { ...body, brandColor: "#0A7C66" },
      { ...body, brandColor: "#0a7c6" },
      { slug: body.slug },
    ]) {
      expect(
        CreateOrganizationSchema.safeParse(bad).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  test("an update takes at least one editable field; the slug, the region and the id are not fields (D5); the brand colour may be cleared", () => {
    expect(UpdateOrganizationSchema.parse({ legalName: "Acme" })).toEqual({
      legalName: "Acme",
    });
    expect(UpdateOrganizationSchema.parse({ brandColor: null })).toEqual({
      brandColor: null,
    });
    for (const bad of [
      {},
      { slug: "other" },
      { dataRegion: "eu-west-1" },
      { id: ORG },
      { legalName: "" },
    ]) {
      expect(
        UpdateOrganizationSchema.safeParse(bad).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });
});

describe("OrganizationsService.create before Tx A", () => {
  test("outside a @SignedIn() request: no tenant context, nothing runs", async () => {
    const f = fakes();
    await expect(
      runWithRequestContext(CTX, () => f.service.create(input(), KEY)),
    ).rejects.toBeInstanceOf(NoTenantContextError);
    expect(f.calls).toEqual([]);
  });

  test("no directory writer: 503 server_unavailable (D3), nothing runs", async () => {
    const f = fakes({ writer: "none" });
    expect(await codeOf(signedIn(() => f.service.create(input(), KEY)))).toBe(
      "server_unavailable",
    );
    expect(f.calls).toEqual([]);
  });

  test.each([
    [undefined, "idempotency.key_missing"],
    [["a", "b"], "idempotency.key_invalid"],
    ["", "idempotency.key_invalid"],
    ["has space", "idempotency.key_invalid"],
    ["x".repeat(256), "idempotency.key_invalid"],
  ] as const)("Idempotency-Key %j: %s, nothing runs", async (key, code) => {
    const f = fakes();
    expect(
      await codeOf(
        signedIn(() =>
          f.service.create(input(), key as string | string[] | undefined),
        ),
      ),
    ).toBe(code);
    expect(f.calls).toEqual([]);
  });

  test("a reserved slug is 409 organization.slug_unavailable (D14), nothing runs", async () => {
    const f = fakes();
    expect(
      await codeOf(
        signedIn(() =>
          f.service.create(
            CreateOrganizationSchema.parse({ ...body, slug: "admin" }),
            KEY,
          ),
        ),
      ),
    ).toBe("organization.slug_unavailable");
    expect(f.calls).toEqual([]);
  });
});

describe("OrganizationsService.create: Tx A and the directory", () => {
  const pending = (state: Attempt["state"], requestHash: Buffer): Attempt => ({
    requestHash,
    orgId: EXISTING_ORG,
    slug: body.slug,
    state,
  });

  /** The request hash create() computes for `body` (from a recorded run). */
  const hashOfBody = async () => {
    const f = fakes({ writer: new Error("down") });
    await codeOf(signedIn(() => f.service.create(input(), KEY)));
    const inserted = f.inserted();
    if (inserted === undefined) throw new Error("no attempt inserted");
    return inserted.requestHash;
  };

  test("the cap: past ORGS_MAX_CREATED_PER_USER pending + committed attempts is 409 request.conflict under the user lock; nothing inserted or registered", async () => {
    const f = fakes({ counted: 2 });
    expect(await codeOf(signedIn(() => f.service.create(input(), KEY)))).toBe(
      "request.conflict",
    );
    expect(f.calls).toEqual([
      "tx-signed-in:candidate",
      "lock",
      "find",
      "count",
    ]);
  });

  test("another body under the same key is 422 idempotency.key_reused; nothing inserted or registered", async () => {
    const f = fakes({ attempt: pending("pending", Buffer.alloc(32, 1)) });
    expect(await codeOf(signedIn(() => f.service.create(input(), KEY)))).toBe(
      "idempotency.key_reused",
    );
    expect(f.calls).toEqual(["tx-signed-in:candidate", "lock", "find"]);
  });

  test("a refused attempt replays the same 409 without the directory", async () => {
    const f = fakes({ attempt: pending("refused", await hashOfBody()) });
    expect(await codeOf(signedIn(() => f.service.create(input(), KEY)))).toBe(
      "organization.slug_unavailable",
    );
    expect(f.calls).toEqual(["tx-signed-in:candidate", "lock", "find"]);
  });

  test("a pending attempt resumes with its own org id (R4): the directory is asked for that id, not a new one", async () => {
    const f = fakes({
      attempt: pending("pending", await hashOfBody()),
      writer: new Error("down"),
    });
    expect(await codeOf(signedIn(() => f.service.create(input(), KEY)))).toBe(
      "server_unavailable",
    );
    expect(f.registrations).toEqual([
      { orgId: EXISTING_ORG, slug: body.slug, cellId: "af-south-1" },
    ]);
    expect(f.calls).not.toContain("insert");
  });

  test("a new key: the attempt is inserted pending with a new org id, then the directory is asked for it in this cell", async () => {
    const f = fakes({ writer: new Error("down") });
    await codeOf(signedIn(() => f.service.create(input(), KEY)));
    expect(f.calls).toEqual([
      "tx-signed-in:candidate",
      "lock",
      "find",
      "count",
      "insert",
      "register",
    ]);
    expect(f.registrations).toEqual([
      { orgId: f.inserted()?.orgId, slug: body.slug, cellId: "af-south-1" },
    ]);
  });

  test("slug_taken settles the attempt refused and answers 409 organization.slug_unavailable (D14)", async () => {
    const f = fakes({ writer: new DirectoryRegistrationError("slug_taken") });
    expect(await codeOf(signedIn(() => f.service.create(input(), KEY)))).toBe(
      "organization.slug_unavailable",
    );
    expect(f.settled).toEqual(["refused"]);
    expect(f.calls.slice(-2)).toEqual([
      "tx-signed-in:candidate",
      "settle:refused",
    ]);
  });

  test.each([
    ["unknown_cell", new DirectoryRegistrationError("unknown_cell")],
    [
      "org_registered_differently",
      new DirectoryRegistrationError("org_registered_differently"),
    ],
    ["an unreachable directory", new Error("connect ECONNREFUSED")],
  ])(
    "%s: 503 server_unavailable; the attempt stays pending",
    async (_, error) => {
      const f = fakes({ writer: error });
      expect(await codeOf(signedIn(() => f.service.create(input(), KEY)))).toBe(
        "server_unavailable",
      );
      expect(f.settled).toEqual([]);
      expect(f.calls.at(-1)).toBe("register");
      // One warning with the org id and a code, never the error's text.
      const warnings = f.warnings();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        msg: "organizations.directory_failed",
        orgId: f.inserted()?.orgId,
        code:
          error instanceof DirectoryRegistrationError
            ? error.code
            : "directory_unavailable",
      });
      expect(JSON.stringify(warnings)).not.toContain("ECONNREFUSED");
    },
  );
});

describe("OrganizationsService.archiveCurrent", () => {
  test("sets archived_at and updated_at in the request's org and records org.organization.archive last", async () => {
    const f = fakes();
    const result = await member(() => f.service.archiveCurrent());
    expect(result).toMatchObject({ id: ORG, archivedAt: NOW, units: "metric" });
    expect(f.calls).toEqual([
      "tx",
      "update:archivedAt,updatedAt",
      "audit:org.organization.archive",
    ]);
    expect(f.audits).toEqual([
      {
        action: "org.organization.archive",
        entityId: ORG,
        after: { archivedAt: NOW },
      },
    ]);
  });

  test("an organisation RLS hides is 404 not_found and nothing is audited", async () => {
    const f = fakes({ updated: undefined });
    expect(await codeOf(member(() => f.service.archiveCurrent()))).toBe(
      "not_found",
    );
    expect(f.audits).toEqual([]);
  });

  test("without an identity nothing runs", async () => {
    const f = fakes();
    await expect(
      runWithRequestContext(CTX, () => f.service.archiveCurrent()),
    ).rejects.toBeInstanceOf(Error);
    expect(f.calls).toEqual([]);
  });
});
