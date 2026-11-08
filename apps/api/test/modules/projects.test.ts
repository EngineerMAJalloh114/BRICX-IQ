// Projects' and sites' services without a database (P6-05, ADR 0075;
// owner conditions C1, C3, C4, C5, C7, C8): the repository, the region
// layers and the audit are recording fakes, so these prove the services'
// own decisions in order; projects.int.test.ts and
// p6-05-sites-access.int.test.ts prove the rows, RLS and the routes
// against Postgres.
// - visibility first (C5): an unseen project or site, or one the caller
//   may not read, is 404 before any other check;
// - then the action (403), then state (archived 409; C1's lock 409; the
//   status machine 409, C3);
// - the contract value (C8) is answered only to an update-key holder,
//   and its amount never reaches the audit event;
// - a database refusal is mapped (CHECK 422, guard trigger 409, a site's
//   polygon CHECKs 422 at boundary), anything else rethrown;
// - no change writes nothing and records nothing;
// - lists page by id with a cursor (limit + 1 read).
import type { Tx } from "@bricx/db/database";
import type * as RegionConfigs from "@bricx/db/region-configs";
import type { RegionLayers } from "@bricx/db/region-configs";
import type { Grant } from "@bricx/permissions/ability";
import { GeoPolygonSchema } from "@bricx/validation/geo";
import { describe, expect, test, vi } from "vitest";
import type { Identity } from "../../src/common/db/request-context.js";
import {
  runWithRequestContext,
  setIdentity,
} from "../../src/common/db/request-context.js";
import {
  ApiError,
  ValidationError,
} from "../../src/common/errors/api-error.js";
import {
  PageCursor,
  decodeCursor,
  encodeCursor,
} from "../../src/modules/projects/projects.dto.js";
import type {
  NewProject,
  NewSite,
  PageQuery,
  ProjectFields,
  ProjectRow,
  ProjectsRepository,
  SiteFields,
  SiteRow,
} from "../../src/modules/projects/projects.repository.js";
import { ProjectsService } from "../../src/modules/projects/projects.service.js";
import { SitesService } from "../../src/modules/projects/sites.service.js";
import type {
  AuditRecorder,
  TransactionRunner,
} from "../../src/modules/sessions/public-api.js";
import { grantsOf } from "../support/auth.js";

const ORG = "0199e1a0-0000-7000-8000-000000000e0a";
const USER = "0199e1a0-0000-7000-8000-000000000e01";
const OTHER_USER = "0199e1a0-0000-7000-8000-000000000e02";
const PROJECT = "0199e1a0-0000-7000-8000-000000000e0b";
const OTHER_PROJECT = "0199e1a0-0000-7000-8000-000000000e0c";
const SITE = "0199e1a0-0000-7000-8000-000000000e5a";
const OTHER_SITE = "0199e1a0-0000-7000-8000-000000000e5b";
const T0 = "2026-11-08T10:00:00.000Z";
const NOW_MS = Date.UTC(2026, 10, 8, 12, 0, 0);
const NOW = new Date(NOW_MS).toISOString();
const SQUARE = GeoPolygonSchema.parse({
  type: "Polygon",
  coordinates: [
    [
      [-13.2, 8.4],
      [-13.1, 8.4],
      [-13.1, 8.5],
      [-13.2, 8.5],
      [-13.2, 8.4],
    ],
  ],
});

const layers = vi.hoisted(() => ({
  value: undefined as RegionLayers | undefined,
}));
vi.mock("@bricx/db/region-configs", async (importOriginal) => {
  const real = await importOriginal<typeof RegionConfigs>();
  return {
    ...real,
    readRegionLayers: () => Promise.resolve(layers.value),
  };
});
layers.value = {
  organization: {
    country: "SL",
    currency: "SLE",
    language: "en",
    timezone: "Africa/Freetown",
    units: "metric",
  },
  org: undefined,
  project: undefined,
};

const identity = (grants: readonly Grant[], projects: string[] = []) =>
  ({
    orgId: ORG,
    userId: USER,
    projectIds: projects,
    allProjects: false,
    grants: [...grants],
    membershipGrants: [...grants],
    sessionId: "0199e1a0-0000-7000-8000-000000000e5e",
    deviceId: undefined,
    acr: "pwd",
  }) as unknown as Identity;
const as = (roles: string[], projects: string[] = []) =>
  identity(grantsOf({ roles, projects }), projects);
/** Site-level grants on `sites` (a site role's assigned sites, C4). */
const siteGrants = (keys: readonly string[], sites: readonly string[]) =>
  keys.map(
    (permission) =>
      ({ permission, scope: "site", siteIds: [...sites] }) as unknown as Grant,
  );

const OWNER = as(["owner"]);
/** project_manager on PROJECT: update and sites, never archive. */
const MANAGER = as(["project_manager"], [PROJECT]);
/** project_owner on PROJECT: update and archive. */
const PROJECT_OWNER = as(["project_owner"], [PROJECT]);
/** client on PROJECT: reads the project, never updates it. */
const CLIENT = as(["client"], [PROJECT]);

const projectRow = (over: Partial<ProjectRow> = {}): ProjectRow => ({
  id: PROJECT,
  code: "PRJ-1",
  name: "Lumley bridge",
  clientName: null,
  status: "draft",
  currency: "SLE",
  reportingCurrency: "SLE",
  timezone: "Africa/Freetown",
  startDate: null,
  endDate: null,
  contractValueMinor: "125000",
  contractValueCurrency: "SLE",
  createdBy: OTHER_USER,
  createdAt: T0,
  updatedAt: T0,
  archivedAt: null,
  ...over,
});
const siteRow = (over: Partial<SiteRow> = {}): SiteRow => ({
  id: SITE,
  projectId: PROJECT,
  name: "North abutment",
  boundary: null,
  address: null,
  geofenceRadiusM: 0,
  createdBy: OTHER_USER,
  createdAt: T0,
  updatedAt: T0,
  archivedAt: null,
  ...over,
});

const pgError = (code: string, constraint?: string) =>
  Object.assign(new Error("db"), { code, constraint });

interface Fakes {
  readonly projects: Map<string, ProjectRow>;
  readonly sites: Map<string, SiteRow>;
  readonly calls: string[];
  readonly audits: Record<string, unknown>[];
  writeError: Error | undefined;
  pages: { projects: ProjectRow[]; sites: SiteRow[] };
  readonly queries: PageQuery[];
  readonly projectService: ProjectsService;
  readonly siteService: SitesService;
}

function fakes(
  projects: ProjectRow[] = [projectRow()],
  sites: SiteRow[] = [siteRow()],
): Fakes {
  const f = {
    projects: new Map(projects.map((p) => [p.id, p])),
    sites: new Map(sites.map((s) => [s.id, s])),
    calls: [] as string[],
    audits: [] as Record<string, unknown>[],
    writeError: undefined as Error | undefined,
    pages: { projects: [] as ProjectRow[], sites: [] as SiteRow[] },
    queries: [] as PageQuery[],
  };
  const fail = () =>
    f.writeError === undefined ? undefined : Promise.reject(f.writeError);
  const repository = {
    findProject: (_tx: Tx, orgId: string, id: string) => {
      f.calls.push(`find:${id}`);
      expect(orgId).toBe(ORG);
      return Promise.resolve(f.projects.get(id));
    },
    lockProject: (_tx: Tx, _orgId: string, id: string) => {
      f.calls.push(`lock:${id}`);
      return Promise.resolve(f.projects.get(id));
    },
    insertProject: (_tx: Tx, input: NewProject) => {
      f.calls.push("insertProject");
      return (
        fail() ??
        Promise.resolve(
          projectRow({
            id: input.id,
            code: input.code,
            name: input.name,
            clientName: input.clientName,
            currency: input.currency,
            reportingCurrency: input.reportingCurrency,
            timezone: input.timezone,
            startDate: input.startDate,
            endDate: input.endDate,
            contractValueMinor:
              input.contractValueMinor === null
                ? null
                : String(input.contractValueMinor),
            contractValueCurrency: input.contractValueCurrency,
            createdBy: input.createdBy,
            createdAt: input.now,
            updatedAt: input.now,
          }),
        )
      );
    },
    updateProject: (
      _tx: Tx,
      _orgId: string,
      id: string,
      changes: Partial<ProjectFields> & {
        status?: string;
        archivedAt?: string;
      },
      now: string,
    ) => {
      f.calls.push(`updateProject:${Object.keys(changes).sort().join(",")}`);
      const before = f.projects.get(id) ?? projectRow();
      const { contractValueMinor, ...rest } = changes;
      return (
        fail() ??
        Promise.resolve({
          ...before,
          ...rest,
          ...(contractValueMinor === undefined
            ? {}
            : {
                contractValueMinor:
                  contractValueMinor === null
                    ? null
                    : String(contractValueMinor),
              }),
          updatedAt: now,
        } as ProjectRow)
      );
    },
    listProjects: (_tx: Tx, _orgId: string, query: PageQuery) => {
      f.queries.push(query);
      return Promise.resolve(f.pages.projects);
    },
    findSite: (_tx: Tx, _orgId: string, projectId: string, id: string) => {
      f.calls.push(`findSite:${id}`);
      const site = f.sites.get(id);
      return Promise.resolve(site?.projectId === projectId ? site : undefined);
    },
    insertSite: (_tx: Tx, input: NewSite) => {
      f.calls.push("insertSite");
      return (
        fail() ??
        Promise.resolve(
          siteRow({
            id: input.id,
            projectId: input.projectId,
            name: input.name,
            boundary:
              input.boundary === null ? null : JSON.stringify(input.boundary),
            address: input.address,
            geofenceRadiusM: input.geofenceRadiusM,
            createdBy: input.createdBy,
            createdAt: input.now,
            updatedAt: input.now,
          }),
        )
      );
    },
    updateSite: (
      _tx: Tx,
      _orgId: string,
      _projectId: string,
      id: string,
      changes: Partial<SiteFields> & { archivedAt?: string },
      now: string,
    ) => {
      f.calls.push(`updateSite:${Object.keys(changes).sort().join(",")}`);
      const before = f.sites.get(id) ?? siteRow();
      const { boundary, ...rest } = changes;
      return (
        fail() ??
        Promise.resolve({
          ...before,
          ...rest,
          ...(boundary === undefined
            ? {}
            : {
                boundary: boundary === null ? null : JSON.stringify(boundary),
              }),
          updatedAt: now,
        } as SiteRow)
      );
    },
    listSites: (
      _tx: Tx,
      _orgId: string,
      _projectId: string,
      query: PageQuery,
    ) => {
      f.queries.push(query);
      return Promise.resolve(f.pages.sites);
    },
  } as unknown as ProjectsRepository;
  const runner: TransactionRunner = {
    run: <T>(fn: (tx: Tx) => Promise<T>) => {
      f.calls.push("tx");
      return fn({} as unknown as Tx);
    },
  };
  const audit = {
    record: (_tx: Tx, event: Record<string, unknown>) => {
      f.calls.push(`audit:${String(event.action)}`);
      f.audits.push(event);
      return Promise.resolve({ seq: 1n });
    },
  } as unknown as AuditRecorder;
  const clock = { now: () => NOW_MS };
  return {
    ...f,
    get writeError() {
      return f.writeError;
    },
    set writeError(error: Error | undefined) {
      f.writeError = error;
    },
    projectService: new ProjectsService(runner, repository, audit, clock),
    siteService: new SitesService(runner, repository, audit, clock),
  };
}

/** Runs `fn` as `who`; a synchronous throw (a check before the transaction) rejects too. */
const run = async <T>(who: Identity, fn: () => Promise<T>): Promise<T> =>
  runWithRequestContext(
    { correlationId: "corr-1", ip: "127.0.0.1", deviceId: undefined },
    () => {
      setIdentity(who);
      return fn();
    },
  );

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) =>
      error instanceof ValidationError
        ? `422:${JSON.stringify(error.envelope.issues?.map((i) => [i.path, i.code]))}`
        : String((error as { code?: unknown }).code),
  );

describe("ProjectsService: visibility, action, state (C5, C3, C1)", () => {
  test("get: an unknown project and one the caller may not read are the same 404; a reader gets it", async () => {
    const f = fakes();
    expect(
      await code(run(OWNER, () => f.projectService.get(OTHER_PROJECT))),
    ).toBe("not_found");
    // project_manager of another project: the row exists, but 404 (C5).
    const elsewhere = as(["project_manager"], [OTHER_PROJECT]);
    expect(
      await code(run(elsewhere, () => f.projectService.get(PROJECT))),
    ).toBe("not_found");
    const got = await run(MANAGER, () => f.projectService.get(PROJECT));
    expect(got).toMatchObject({ id: PROJECT, status: "draft" });
  });

  test("the contract value is answered only to an update-key holder (C8): the manager reads it, the client reads null", async () => {
    const f = fakes();
    expect(
      (await run(MANAGER, () => f.projectService.get(PROJECT))).contractValue,
    ).toEqual({ amount: "125000", currency: "SLE" });
    expect(
      (await run(CLIENT, () => f.projectService.get(PROJECT))).contractValue,
    ).toBeNull();
    const none = fakes([
      projectRow({ contractValueMinor: null, contractValueCurrency: null }),
    ]);
    expect(
      (await run(MANAGER, () => none.projectService.get(PROJECT)))
        .contractValue,
    ).toBeNull();
  });

  test("update: 404 before 403 before 409; the client is 403, an archived project 409, nothing written", async () => {
    const f = fakes([
      projectRow(),
      projectRow({ id: OTHER_PROJECT, status: "archived", archivedAt: T0 }),
    ]);
    const elsewhere = as(["project_manager"], [OTHER_PROJECT]);
    expect(
      await code(
        run(elsewhere, () => f.projectService.update(PROJECT, { name: "x" })),
      ),
    ).toBe("not_found");
    expect(
      await code(
        run(CLIENT, () => f.projectService.update(PROJECT, { name: "x" })),
      ),
    ).toBe("forbidden");
    expect(
      await code(
        run(OWNER, () => f.projectService.update(OTHER_PROJECT, { name: "x" })),
      ),
    ).toBe("request.conflict");
    expect(f.calls.filter((c) => c.startsWith("update"))).toEqual([]);
    expect(f.audits).toEqual([]);
  });

  test("C1: currency, reporting currency and timezone change in draft only; other fields still change once active", async () => {
    const draft = fakes();
    const changed = await run(OWNER, () =>
      draft.projectService.update(PROJECT, {
        currency: "USD",
        reportingCurrency: "USD",
        timezone: "Africa/Accra",
      }),
    );
    expect(changed).toMatchObject({
      currency: "USD",
      timezone: "Africa/Accra",
    });
    expect(draft.audits).toEqual([
      {
        action: "project.project.update",
        entityType: "project.project",
        entityId: PROJECT,
        after: { fields: ["currency", "reportingCurrency", "timezone"] },
      },
    ]);
    for (const field of [
      "currency",
      "reportingCurrency",
      "timezone",
    ] as const) {
      const active = fakes([projectRow({ status: "active" })]);
      const value = field === "timezone" ? "Africa/Accra" : "USD";
      expect(
        await code(
          run(OWNER, () =>
            active.projectService.update(PROJECT, { [field]: value }),
          ),
        ),
        field,
      ).toBe("request.conflict");
      expect(active.audits).toEqual([]);
    }
    // The same value once active is no change, not a refusal.
    const same = fakes([projectRow({ status: "active" })]);
    await run(OWNER, () =>
      same.projectService.update(PROJECT, { currency: "SLE" }),
    );
    expect(same.calls).toEqual(["tx", `lock:${PROJECT}`]);
    const name = fakes([projectRow({ status: "on_hold" })]);
    expect(
      await run(OWNER, () =>
        name.projectService.update(PROJECT, { name: "New" }),
      ),
    ).toMatchObject({ name: "New", status: "on_hold" });
  });

  test("the contract value: a change audits its field name only, never the amount; an equal one writes nothing", async () => {
    const f = fakes();
    await run(MANAGER, () =>
      f.projectService.update(PROJECT, {
        contractValue: { amount: 990000n, currency: "SLE" } as never,
      }),
    );
    expect(f.audits).toHaveLength(1);
    expect(JSON.stringify(f.audits)).not.toContain("990000");
    expect(f.audits[0]?.after).toEqual({ fields: ["contractValue"] });
    const same = fakes();
    await run(MANAGER, () =>
      same.projectService.update(PROJECT, {
        contractValue: { amount: 125000n, currency: "SLE" } as never,
      }),
    );
    expect(same.audits).toEqual([]);
    const cleared = fakes();
    expect(
      (
        await run(MANAGER, () =>
          cleared.projectService.update(PROJECT, { contractValue: null }),
        )
      ).contractValue,
    ).toBeNull();
  });

  test("start after end is 422 at endDate, on create and on update (against the stored date)", async () => {
    const f = fakes([projectRow({ startDate: "2026-12-01" })]);
    expect(
      await code(
        run(OWNER, () =>
          f.projectService.update(PROJECT, { endDate: "2026-11-30" }),
        ),
      ),
    ).toBe('422:[[["endDate"],"invalid_value"]]');
    expect(
      await code(
        run(OWNER, () =>
          f.projectService.create({
            code: "PRJ-2",
            name: "Pier",
            startDate: "2026-12-02",
            endDate: "2026-12-01",
          }),
        ),
      ),
    ).toBe('422:[[["endDate"],"invalid_value"]]');
    expect(f.audits).toEqual([]);
  });

  test("a CHECK violation is 422 validation_failed, the guard trigger 409, anything else rethrown; no audit after a refusal", async () => {
    for (const [error, wanted] of [
      [pgError("23514", "projects_name"), "validation_failed"],
      [pgError("P6004"), "request.conflict"],
    ] as const) {
      const f = fakes();
      f.writeError = error;
      expect(
        await code(
          run(OWNER, () => f.projectService.update(PROJECT, { name: "x" })),
        ),
      ).toBe(wanted);
      expect(f.audits).toEqual([]);
    }
    const f = fakes();
    const boom = new Error("boom");
    f.writeError = boom;
    await expect(
      run(OWNER, () => f.projectService.move(PROJECT, "active")),
    ).rejects.toBe(boom);
  });
});

describe("ProjectsService.create (C7, C8, D7)", () => {
  test("defaults currency, reporting currency and timezone from the org's effective configuration; one create event without the contract amount", async () => {
    const f = fakes([]);
    const created = await run(OWNER, () =>
      f.projectService.create({
        code: "PRJ-9",
        name: "Pier",
        contractValue: { amount: 5000n, currency: "SLE" } as never,
      }),
    );
    expect(created).toMatchObject({
      code: "PRJ-9",
      status: "draft",
      currency: "SLE",
      reportingCurrency: "SLE",
      timezone: "Africa/Freetown",
      contractValue: { amount: "5000", currency: "SLE" },
      createdBy: USER,
      createdAt: NOW,
    });
    expect(f.calls).toEqual([
      "tx",
      "insertProject",
      "audit:project.project.create",
    ]);
    expect(f.audits[0]).toEqual({
      action: "project.project.create",
      entityType: "project.project",
      entityId: created.id,
      after: {
        code: "PRJ-9",
        status: "draft",
        currency: "SLE",
        reportingCurrency: "SLE",
        timezone: "Africa/Freetown",
      },
    });
  });

  test("given values win over the defaults; a caller without project.project.create is 403 before any transaction; a duplicate code is 409", async () => {
    const f = fakes([]);
    expect(
      await run(OWNER, () =>
        f.projectService.create({
          code: "PRJ-8",
          name: "Pier",
          currency: "USD",
          reportingCurrency: "EUR",
          timezone: "Africa/Accra",
        }),
      ),
    ).toMatchObject({
      currency: "USD",
      reportingCurrency: "EUR",
      timezone: "Africa/Accra",
    });
    const g = fakes([]);
    expect(
      await code(
        run(MANAGER, () => g.projectService.create({ code: "P", name: "x" })),
      ),
    ).toBe("forbidden");
    expect(g.calls).toEqual([]);
    const h = fakes([]);
    // The repository maps a unique violation (projects_code) to 409.
    h.writeError = new ApiError("request.conflict");
    expect(
      await code(
        run(OWNER, () => h.projectService.create({ code: "P", name: "x" })),
      ),
    ).toBe("request.conflict");
    expect(h.audits).toEqual([]);
  });

  test("the organisation's own layer applies when it sets a reporting currency", async () => {
    const saved = layers.value;
    layers.value = {
      organization: {
        country: "SL",
        currency: "SLE",
        language: "en",
        timezone: "Africa/Freetown",
        units: "us_customary",
      },
      org: {
        id: "0199e1a0-0000-7000-8000-000000000e99",
        orgId: ORG,
        projectId: null,
        currency: null,
        reportingCurrency: "USD",
        language: null,
        timezone: null,
        formatLocale: null,
        units: "metric",
        taxProfileId: null,
        paymentAdapters: null,
        accountingAdapter: null,
        rateLibrary: null,
        sessionIdleSeconds: null,
        createdAt: T0,
        updatedAt: T0,
      },
      project: undefined,
    };
    try {
      const f = fakes([]);
      expect(
        await run(OWNER, () =>
          f.projectService.create({ code: "P", name: "x" }),
        ),
      ).toMatchObject({ currency: "SLE", reportingCurrency: "USD" });
    } finally {
      layers.value = saved;
    }
  });
});

describe("ProjectsService.move (C3)", () => {
  test("allowed moves: status audited before and after; archive sets archivedAt; refused moves 409", async () => {
    const f = fakes();
    const active = await run(MANAGER, () =>
      f.projectService.move(PROJECT, "active"),
    );
    expect(active.status).toBe("active");
    expect(f.audits).toEqual([
      {
        action: "project.project.status",
        entityType: "project.project",
        entityId: PROJECT,
        before: { status: "draft" },
        after: { status: "active" },
      },
    ]);
    const done = fakes([projectRow({ status: "completed" })]);
    const archived = await run(PROJECT_OWNER, () =>
      done.projectService.move(PROJECT, "archived"),
    );
    expect(archived).toMatchObject({ status: "archived", archivedAt: NOW });
    expect(done.calls).toContain("updateProject:archivedAt,status");
    for (const [from, to] of [
      ["draft", "completed"],
      ["active", "draft"],
      ["archived", "active"],
      ["completed", "active"],
    ] as const) {
      const g = fakes([projectRow({ status: from })]);
      expect(
        await code(run(OWNER, () => g.projectService.move(PROJECT, to))),
        `${from} -> ${to}`,
      ).toBe("request.conflict");
      expect(g.audits).toEqual([]);
    }
  });

  test("archive needs project.project.archive, other moves project.project.update: the client is 403 on both", async () => {
    const f = fakes();
    expect(
      await code(run(CLIENT, () => f.projectService.move(PROJECT, "active"))),
    ).toBe("forbidden");
    expect(
      await code(run(CLIENT, () => f.projectService.move(PROJECT, "archived"))),
    ).toBe("forbidden");
    // project_manager holds update but not archive on its project.
    const qs = MANAGER;
    expect(
      await code(run(qs, () => f.projectService.move(PROJECT, "archived"))),
    ).toBe("forbidden");
    expect(
      await code(run(qs, () => f.projectService.move(PROJECT, "active"))),
    ).toBe("ok");
  });
});

describe("lists: keyset paging by id (C5)", () => {
  test("projects: limit + 1 read, the next cursor is the last answered id, none on the last page; the caller's read filters are passed", async () => {
    const f = fakes();
    const rows = [OTHER_PROJECT, PROJECT, SITE].map((id) => projectRow({ id }));
    f.pages.projects = rows;
    const page = await run(OWNER, () =>
      f.projectService.list({ limit: 2, cursor: undefined, status: undefined }),
    );
    expect(page.items.map((p) => p.id)).toEqual([OTHER_PROJECT, PROJECT]);
    expect(page.nextCursor).toBe(encodeCursor(PROJECT));
    expect(f.queries[0]).toMatchObject({ limit: 3, before: undefined });
    expect(f.queries[0]?.filters.length).toBeGreaterThan(0);
    f.pages.projects = rows.slice(0, 1);
    const last = await run(OWNER, () =>
      f.projectService.list({
        limit: 2,
        cursor: PageCursor.parse(encodeCursor(PROJECT)),
        status: "active",
      }),
    );
    expect(last.nextCursor).toBeNull();
    expect(f.queries[1]).toMatchObject({
      before: decodeCursor(encodeCursor(PROJECT)),
      status: "active",
    });
  });

  test("sites: the project is checked first (404), then a page of the project's sites", async () => {
    const f = fakes();
    expect(
      await code(
        run(OWNER, () =>
          f.siteService.list(OTHER_PROJECT, { limit: 1, cursor: undefined }),
        ),
      ),
    ).toBe("not_found");
    f.pages.sites = [siteRow(), siteRow({ id: OTHER_SITE })];
    const page = await run(OWNER, () =>
      f.siteService.list(PROJECT, { limit: 1, cursor: undefined }),
    );
    expect(page.items.map((s) => s.id)).toEqual([SITE]);
    expect(page.nextCursor).toBe(encodeCursor(SITE));
    const all = await run(OWNER, () =>
      f.siteService.list(PROJECT, {
        limit: 5,
        cursor: PageCursor.parse(encodeCursor(SITE)),
      }),
    );
    expect(all.nextCursor).toBeNull();
  });
});

describe("SitesService (C4, C5, C6)", () => {
  test("get: an unknown project, an unknown site, a site of another project and an unassigned site are all 404; an assigned site key reads it", async () => {
    const f = fakes(
      [projectRow()],
      [siteRow(), siteRow({ id: OTHER_SITE, projectId: OTHER_PROJECT })],
    );
    expect(
      await code(run(OWNER, () => f.siteService.get(OTHER_PROJECT, SITE))),
    ).toBe("not_found");
    expect(
      await code(run(OWNER, () => f.siteService.get(PROJECT, OTHER_SITE))),
    ).toBe("not_found");
    const project = grantsOf({ roles: ["client"], projects: [PROJECT] });
    const assigned = identity(
      [...project, ...siteGrants(["project.site.read"], [SITE])],
      [PROJECT],
    );
    const unassigned = identity(
      [...project, ...siteGrants(["project.site.read"], [OTHER_SITE])],
      [PROJECT],
    );
    // client holds project read but no site key: 404 (C4).
    expect(
      await code(run(CLIENT, () => f.siteService.get(PROJECT, SITE))),
    ).toBe("not_found");
    expect(
      await code(run(unassigned, () => f.siteService.get(PROJECT, SITE))),
    ).toBe("not_found");
    expect(
      await run(assigned, () => f.siteService.get(PROJECT, SITE)),
    ).toMatchObject({
      id: SITE,
      boundary: null,
    });
  });

  test("create: 404 unseen project, 403 without project.site.create, 409 on an archived project; one create event saying whether a boundary was given", async () => {
    const f = fakes([
      projectRow(),
      projectRow({ id: OTHER_PROJECT, status: "archived", archivedAt: T0 }),
    ]);
    expect(
      await code(
        run(MANAGER, () => f.siteService.create(OTHER_PROJECT, { name: "x" })),
      ),
    ).toBe("not_found");
    expect(
      await code(
        run(CLIENT, () => f.siteService.create(PROJECT, { name: "x" })),
      ),
    ).toBe("forbidden");
    expect(
      await code(
        run(OWNER, () => f.siteService.create(OTHER_PROJECT, { name: "x" })),
      ),
    ).toBe("request.conflict");
    expect(f.audits).toEqual([]);
    const site = await run(MANAGER, () =>
      f.siteService.create(PROJECT, {
        name: "Yard",
        boundary: SQUARE,
        geofenceRadiusM: 50,
      }),
    );
    expect(site).toMatchObject({
      projectId: PROJECT,
      name: "Yard",
      boundary: SQUARE,
      geofenceRadiusM: 50,
      address: null,
      createdBy: USER,
    });
    expect(f.audits).toEqual([
      {
        action: "project.site.create",
        entityType: "project.site",
        entityId: site.id,
        after: { projectId: PROJECT, hasBoundary: true },
      },
    ]);
  });

  test("the polygon CHECKs are 422 at boundary (invalid_polygon, polygon_too_large); another CHECK validation_failed; the guard 409; anything else rethrown", async () => {
    for (const [error, wanted] of [
      [
        pgError("23514", "sites_geom_valid"),
        '422:[[["boundary"],"invalid_polygon"]]',
      ],
      [
        pgError("23514", "sites_geom_shape"),
        '422:[[["boundary"],"invalid_polygon"]]',
      ],
      [
        pgError("23514", "sites_geom_area"),
        '422:[[["boundary"],"polygon_too_large"]]',
      ],
      [pgError("23514", "sites_name"), "validation_failed"],
      [pgError("23514"), "validation_failed"],
      [pgError("P6005"), "request.conflict"],
    ] as const) {
      const f = fakes();
      f.writeError = error;
      expect(
        await code(
          run(OWNER, () =>
            f.siteService.create(PROJECT, { name: "x", boundary: SQUARE }),
          ),
        ),
        String(error.constraint),
      ).toBe(wanted);
      expect(f.audits).toEqual([]);
    }
    const f = fakes();
    const boom = new Error("boom");
    f.writeError = boom;
    await expect(
      run(OWNER, () => f.siteService.update(PROJECT, SITE, { name: "y" })),
    ).rejects.toBe(boom);
  });

  test("update: only changed fields, their names audited; no change writes nothing; a site key holder updates their assigned site only", async () => {
    const f = fakes(
      [projectRow()],
      [siteRow({ boundary: JSON.stringify(SQUARE) })],
    );
    const same = await run(OWNER, () =>
      f.siteService.update(PROJECT, SITE, {
        name: "North abutment",
        boundary: SQUARE,
      }),
    );
    expect(same.name).toBe("North abutment");
    expect(f.calls.some((c) => c.startsWith("updateSite"))).toBe(false);
    const changed = await run(OWNER, () =>
      f.siteService.update(PROJECT, SITE, {
        name: "South",
        boundary: null,
        address: "Wilkinson Road",
        geofenceRadiusM: 25,
      }),
    );
    expect(changed).toMatchObject({
      name: "South",
      boundary: null,
      address: "Wilkinson Road",
      geofenceRadiusM: 25,
    });
    expect(f.audits.at(-1)).toEqual({
      action: "project.site.update",
      entityType: "project.site",
      entityId: SITE,
      after: { fields: ["address", "boundary", "geofenceRadiusM", "name"] },
    });
    const reader = identity(
      [
        ...grantsOf({ roles: ["client"], projects: [PROJECT] }),
        ...siteGrants(["project.site.read"], [SITE]),
      ],
      [PROJECT],
    );
    expect(
      await code(
        run(reader, () => f.siteService.update(PROJECT, SITE, { name: "z" })),
      ),
    ).toBe("forbidden");
    const editor = identity(
      [
        ...grantsOf({ roles: ["client"], projects: [PROJECT] }),
        ...siteGrants(["project.site.read", "project.site.update"], [SITE]),
      ],
      [PROJECT],
    );
    expect(
      await code(
        run(editor, () => f.siteService.update(PROJECT, SITE, { name: "z" })),
      ),
    ).toBe("ok");
  });

  test("update and archive: an archived site or project is 409; archive sets archivedAt with one archive event, and is final", async () => {
    const archivedSite = fakes([projectRow()], [siteRow({ archivedAt: T0 })]);
    for (const call of [
      () => archivedSite.siteService.update(PROJECT, SITE, { name: "x" }),
      () => archivedSite.siteService.archive(PROJECT, SITE),
    ]) {
      expect(await code(run(OWNER, call))).toBe("request.conflict");
    }
    const archivedProject = fakes([
      projectRow({ status: "archived", archivedAt: T0 }),
    ]);
    for (const call of [
      () => archivedProject.siteService.update(PROJECT, SITE, { name: "x" }),
      () => archivedProject.siteService.archive(PROJECT, SITE),
    ]) {
      expect(await code(run(OWNER, call))).toBe("request.conflict");
    }
    expect(
      await code(
        run(CLIENT, () => archivedSite.siteService.archive(PROJECT, SITE)),
      ),
    ).toBe("not_found");
    const f = fakes();
    expect(
      await code(
        run(
          identity(
            [
              ...grantsOf({ roles: ["client"], projects: [PROJECT] }),
              ...siteGrants(
                ["project.site.read", "project.site.update"],
                [SITE],
              ),
            ],
            [PROJECT],
          ),
          () => f.siteService.archive(PROJECT, SITE),
        ),
      ),
    ).toBe("forbidden");
    const archived = await run(PROJECT_OWNER, () =>
      f.siteService.archive(PROJECT, SITE),
    );
    expect(archived.archivedAt).toBe(NOW);
    expect(f.audits).toEqual([
      {
        action: "project.site.archive",
        entityType: "project.site",
        entityId: SITE,
        before: { archivedAt: null },
        after: { archivedAt: NOW },
      },
    ]);
  });
});
