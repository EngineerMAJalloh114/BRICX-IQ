// Region configuration's service without a database (P6-03, ADR 0073):
// @bricx/db/region-configs is replaced by a recording fake, so these
// prove the service's own decisions; region-config.int.test.ts proves the
// rows, RLS and the routes against Postgres.
// - owner condition C3: a CHECK violation (23514) from the write, the
//   backstop behind the DTO, is 422 validation_failed, never a 500, and no
//   audit event follows; any other error is rethrown as it is;
// - owner condition C1: a body whose values equal the stored ones writes
//   nothing and records nothing; a change records one event naming the
//   changed fields only;
// - P6-04 (ADR 0074, D9): a changed paymentAdapters is checked in full,
//   a changed accountingAdapter by kind; an unknown id is 422
//   unknown_adapter at its path, never the value, with nothing written or
//   audited; an unchanged field is not re-checked (C1), null always passes;
// - an organisation the transaction cannot see is 404;
// - the DTOs refuse an empty body and the fields a layer may not hold.
import type { Tx } from "@bricx/db/database";
import type * as RegionConfigs from "@bricx/db/region-configs";
import type {
  RegionConfigRow,
  RegionConfigWrite,
  RegionLayers,
} from "@bricx/db/region-configs";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  runWithRequestContext,
  setIdentity,
} from "../../src/common/db/request-context.js";
import {
  ApiError,
  ValidationError,
} from "../../src/common/errors/api-error.js";
import {
  UpdateOrgRegionConfigSchema,
  UpdateProjectRegionConfigSchema,
} from "../../src/modules/region-config/region-config.dto.js";
import {
  type RegionConfigAdapters,
  type RegionConfigAudit,
  RegionConfigService,
  type RegionConfigTxRunner,
} from "../../src/modules/region-config/region-config.service.js";

const ORG = "0199e1a0-0000-7000-8000-000000000d0a";
const USER = "0199e1a0-0000-7000-8000-000000000d01";
const PROJECT = "0199e1a0-0000-7000-8000-000000000d0b";
const NOW_MS = Date.UTC(2026, 10, 7, 12, 0, 0);

const store = vi.hoisted(() => ({
  row: undefined as RegionConfigRow | undefined,
  layers: undefined as RegionLayers | undefined,
  writeError: undefined as Error | undefined,
  writes: [] as RegionConfigWrite[],
}));

vi.mock("@bricx/db/region-configs", async (importOriginal) => {
  const real = await importOriginal<typeof RegionConfigs>();
  return {
    ...real,
    readRegionConfig: () => Promise.resolve(store.row),
    readRegionLayers: () => Promise.resolve(store.layers),
    writeRegionConfig: (_tx: Tx, input: RegionConfigWrite) => {
      store.writes.push(input);
      if (store.writeError !== undefined) {
        return Promise.reject(store.writeError);
      }
      return Promise.resolve(rowOf({ id: input.id, ...input.changes }));
    },
  };
});

const rowOf = (over: Partial<RegionConfigRow> = {}): RegionConfigRow => ({
  id: "0199e1a0-0000-7000-8000-000000000d99",
  orgId: ORG,
  projectId: null,
  currency: null,
  reportingCurrency: null,
  language: null,
  timezone: null,
  formatLocale: null,
  units: null,
  taxProfileId: null,
  paymentAdapters: null,
  accountingAdapter: null,
  rateLibrary: null,
  sessionIdleSeconds: null,
  createdAt: "2026-11-07T12:00:00.000000Z",
  updatedAt: "2026-11-07T12:00:00.000000Z",
  ...over,
});

const identity = {
  orgId: ORG,
  userId: USER,
  projectIds: [],
  allProjects: false,
  grants: [],
  membershipGrants: [],
  sessionId: "0199e1a0-0000-7000-8000-000000000d5e",
  deviceId: undefined,
  acr: "pwd",
} as const;
const CTX = {
  correlationId: "0199e1a0-0000-7000-8000-000000000dcc",
  ip: "127.0.0.1",
  deviceId: undefined,
};

/** Known ids by kind; everything else is unknown. */
const KNOWN: Record<string, readonly string[]> = {
  payment: ["mpesa", "stripe", "orange_money"],
  accounting: ["xero"],
};
const registry: RegionConfigAdapters = {
  has: (kind, id) => KNOWN[kind]?.includes(id) === true,
};

function fakes() {
  const audits: unknown[] = [];
  const runner: RegionConfigTxRunner = {
    run: <T>(fn: (tx: Tx) => Promise<T>) => fn({} as unknown as Tx),
  };
  const audit: RegionConfigAudit = {
    record: (_tx, event) => {
      audits.push(event);
      return Promise.resolve({ seq: 1n } as never);
    },
  };
  const service = new RegionConfigService(
    runner,
    audit,
    { now: () => NOW_MS },
    registry,
  );
  return { service, audits };
}

const asMember = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithRequestContext(CTX, () => {
    setIdentity(identity);
    return fn();
  });

beforeEach(() => {
  store.row = undefined;
  store.layers = undefined;
  store.writeError = undefined;
  store.writes = [];
});

describe("updateLayer()", () => {
  test("a CHECK violation (23514) is 422 validation_failed, not a 500, and nothing is audited (C3)", async () => {
    const f = fakes();
    store.writeError = Object.assign(new Error("check"), { code: "23514" });
    const error = await asMember(() =>
      f.service.updateLayer(null, { reportingCurrency: "USD" }),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("validation_failed");
    expect((error as ApiError).status).toBe(422);
    expect(f.audits).toEqual([]);
  });

  test("a CHECK violation wrapped as a cause is 422 too", async () => {
    const f = fakes();
    store.writeError = new Error("query failed", {
      cause: Object.assign(new Error("check"), { code: "23514" }),
    });
    await expect(
      asMember(() => f.service.updateLayer(PROJECT, { units: "metric" })),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  test("any other error is rethrown as it is", async () => {
    const f = fakes();
    const other = Object.assign(new Error("boom"), { code: "40001" });
    store.writeError = other;
    await expect(
      asMember(() => f.service.updateLayer(null, { rateLibrary: "x" })),
    ).rejects.toBe(other);
  });

  test("values equal to the stored ones: no write, no audit event, the row as it is (C1)", async () => {
    const f = fakes();
    store.row = rowOf({ reportingCurrency: "USD", paymentAdapters: ["mpesa"] });
    const result = await asMember(() =>
      f.service.updateLayer(null, {
        reportingCurrency: "USD",
        paymentAdapters: ["mpesa"],
      }),
    );
    expect(result.reportingCurrency).toBe("USD");
    expect(store.writes).toEqual([]);
    expect(f.audits).toEqual([]);
  });

  test("null on a layer with no row changes nothing", async () => {
    const f = fakes();
    const result = await asMember(() =>
      f.service.updateLayer(PROJECT, { currency: null }),
    );
    expect(result).toMatchObject({
      projectId: PROJECT,
      currency: null,
      createdAt: null,
    });
    expect(store.writes).toEqual([]);
    expect(f.audits).toEqual([]);
  });

  test("a change writes only the changed fields and one event naming them, not their values (C1)", async () => {
    const f = fakes();
    store.row = rowOf({ reportingCurrency: "USD" });
    await asMember(() =>
      f.service.updateLayer(PROJECT, {
        reportingCurrency: "USD",
        currency: "EUR",
        taxProfileId: "ng_vat",
      }),
    );
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]).toMatchObject({
      orgId: ORG,
      projectId: PROJECT,
      changes: { currency: "EUR", taxProfileId: "ng_vat" },
      now: "2026-11-07T12:00:00.000Z",
    });
    expect(f.audits).toEqual([
      {
        action: "org.region_config.project_update",
        entityType: "org.region_config",
        entityId: store.writes[0]?.id,
        after: { fields: ["currency", "taxProfileId"] },
      },
    ]);
    expect(JSON.stringify(f.audits)).not.toContain("EUR");
  });
});

describe("updateLayer() and the adapter registry (P6-04, D9)", () => {
  const failure = (work: () => Promise<unknown>): Promise<unknown> =>
    asMember(work).then(
      () => undefined,
      (e: unknown) => e,
    );

  test("an unknown payment id in a changed list: 422 unknown_adapter at the field (the list is sorted, so no index), no value, nothing written or audited", async () => {
    const f = fakes();
    const error = await failure(() =>
      f.service.updateLayer(null, {
        paymentAdapters: ["mpesa", "zz_unknown_pay", "stripe"],
      }),
    );
    expect(error).toBeInstanceOf(ValidationError);
    const envelope = (error as ValidationError).envelope;
    expect(envelope).toMatchObject({
      status: 422,
      code: "validation_failed",
      issues: [
        {
          path: ["paymentAdapters"],
          code: "unknown_adapter",
          key: "validation:unknown_adapter",
        },
      ],
    });
    expect(JSON.stringify(envelope)).not.toContain("zz_unknown_pay");
    expect(store.writes).toEqual([]);
    expect(f.audits).toEqual([]);
  });

  test("a wrong kind is unknown too: an accounting id as a payment adapter, a payment id as the accounting adapter", async () => {
    const f = fakes();
    const error = await failure(() =>
      f.service.updateLayer(PROJECT, {
        paymentAdapters: ["xero"],
        accountingAdapter: "mpesa",
      }),
    );
    expect((error as ValidationError).envelope.issues).toEqual([
      {
        path: ["paymentAdapters"],
        code: "unknown_adapter",
        key: "validation:unknown_adapter",
      },
      {
        path: ["accountingAdapter"],
        code: "unknown_adapter",
        key: "validation:unknown_adapter",
      },
    ]);
    expect(store.writes).toEqual([]);
  });

  test("a changed list is checked in full: a stale stored id must be removed to change it", async () => {
    const f = fakes();
    store.row = rowOf({ paymentAdapters: ["gone_pay", "mpesa"] });
    const error = await failure(() =>
      f.service.updateLayer(null, {
        paymentAdapters: ["gone_pay", "mpesa", "stripe"],
      }),
    );
    expect((error as ValidationError).envelope.issues).toEqual([
      {
        path: ["paymentAdapters"],
        code: "unknown_adapter",
        key: "validation:unknown_adapter",
      },
    ]);
    expect(store.writes).toEqual([]);
    // Without the stale id the change goes through.
    await asMember(() =>
      f.service.updateLayer(null, { paymentAdapters: ["mpesa", "stripe"] }),
    );
    expect(store.writes).toHaveLength(1);
    expect(f.audits).toHaveLength(1);
  });

  test("an unchanged field is not re-checked: a no-change body repeating stale ids is 200, nothing written (C1)", async () => {
    const f = fakes();
    store.row = rowOf({
      paymentAdapters: ["gone_pay"],
      accountingAdapter: "gone_books",
    });
    const result = await asMember(() =>
      f.service.updateLayer(null, {
        paymentAdapters: ["gone_pay"],
        accountingAdapter: "gone_books",
      }),
    );
    expect(result.paymentAdapters).toEqual(["gone_pay"]);
    expect(result.accountingAdapter).toBe("gone_books");
    expect(store.writes).toEqual([]);
    expect(f.audits).toEqual([]);
  });

  test("an unchanged stale field beside a real change is left alone; the change is written", async () => {
    const f = fakes();
    store.row = rowOf({ accountingAdapter: "gone_books" });
    await asMember(() =>
      f.service.updateLayer(null, {
        accountingAdapter: "gone_books",
        reportingCurrency: "USD",
      }),
    );
    expect(store.writes[0]?.changes).toEqual({ reportingCurrency: "USD" });
  });

  test("null and an empty list always pass, even with nothing registered", async () => {
    const f = fakes();
    store.row = rowOf({
      paymentAdapters: ["gone_pay"],
      accountingAdapter: "gone_books",
    });
    await asMember(() =>
      f.service.updateLayer(null, {
        paymentAdapters: [],
        accountingAdapter: null,
      }),
    );
    expect(store.writes[0]?.changes).toEqual({
      paymentAdapters: [],
      accountingAdapter: null,
    });
  });

  test("known ids of the right kind are written", async () => {
    const f = fakes();
    await asMember(() =>
      f.service.updateLayer(PROJECT, {
        paymentAdapters: ["mpesa", "orange_money"],
        accountingAdapter: "xero",
      }),
    );
    expect(store.writes).toHaveLength(1);
    expect(f.audits).toHaveLength(1);
  });

  test("stored ids the registry no longer knows are returned as they are (D10)", async () => {
    const f = fakes();
    store.row = rowOf({
      paymentAdapters: ["gone_pay", "mpesa"],
      accountingAdapter: "gone_books",
    });
    const layer = await asMember(() => f.service.readLayer(null));
    expect(layer.paymentAdapters).toEqual(["gone_pay", "mpesa"]);
    expect(layer.accountingAdapter).toBe("gone_books");
    store.layers = {
      organization: {
        country: "SL",
        currency: "SLE",
        language: "en",
        timezone: "Africa/Freetown",
        units: "metric",
      },
      org: rowOf({ paymentAdapters: ["gone_pay"] }),
      project: rowOf({ projectId: PROJECT, accountingAdapter: "gone_books" }),
    };
    const resolved = await asMember(() => f.service.readEffective(PROJECT));
    expect(resolved.paymentAdapters).toEqual({
      value: ["gone_pay"],
      source: "org",
    });
    expect(resolved.accountingAdapter).toEqual({
      value: "gone_books",
      source: "project",
    });
  });
});

describe("readEffective() and readLayer()", () => {
  test("an organisation the transaction cannot see is 404", async () => {
    const f = fakes();
    await expect(
      asMember(() => f.service.readEffective()),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("resolves the layers; the payment list is a plain copy", async () => {
    const f = fakes();
    store.layers = {
      organization: {
        country: "SL",
        currency: "SLE",
        language: "en",
        timezone: "Africa/Freetown",
        units: "us_customary",
      },
      org: rowOf({ paymentAdapters: ["mpesa"] }),
      project: rowOf({ projectId: PROJECT, units: "metric" }),
    };
    const resolved = await asMember(() => f.service.readEffective(PROJECT));
    expect(resolved.projectId).toBe(PROJECT);
    expect(resolved.units).toEqual({ value: "metric", source: "project" });
    expect(resolved.paymentAdapters).toEqual({
      value: ["mpesa"],
      source: "org",
    });
    expect(Object.isFrozen(resolved.paymentAdapters.value)).toBe(false);
  });

  test("readLayer() with no row: every field null", async () => {
    const f = fakes();
    const layer = await asMember(() => f.service.readLayer(null));
    expect(layer.projectId).toBeNull();
    expect(layer.sessionIdleSeconds).toBeNull();
    expect(layer.updatedAt).toBeNull();
  });
});

describe("the DTOs (C1, C3)", () => {
  test("an empty body is refused on both layers", () => {
    expect(UpdateOrgRegionConfigSchema.safeParse({}).success).toBe(false);
    expect(UpdateProjectRegionConfigSchema.safeParse({}).success).toBe(false);
  });

  test.each(["currency", "language", "timezone", "units"])(
    "the org row refuses %s as an unknown field",
    (field) => {
      const result = UpdateOrgRegionConfigSchema.safeParse({ [field]: null });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe("validation:unknown_field");
    },
  );

  test("a project row refuses the idle timeout as an unknown field", () => {
    const result = UpdateProjectRegionConfigSchema.safeParse({
      sessionIdleSeconds: 600,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("validation:unknown_field");
  });

  test("the payment list is stored sorted; the format locale canonical", () => {
    expect(
      UpdateOrgRegionConfigSchema.parse({
        paymentAdapters: ["stripe", "mpesa"],
        formatLocale: "EN-gb",
      }),
    ).toEqual({ paymentAdapters: ["mpesa", "stripe"], formatLocale: "en-GB" });
  });
});
