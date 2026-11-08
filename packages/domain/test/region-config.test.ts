// Region configuration (P6-03, ADR 0073): resolveRegionConfig() layers
// system -> org -> project, each later one winning, NULL (or absent)
// inheriting, and reports for every field where its value came from.
// P6-05 (ADR 0075 D8, owner condition C1; dated note on ADR 0073): the
// project's own columns are the project layer for currency, reporting
// currency and timezone; a project row never sets them.
// Done-when 1: the suite is generated over REGION_CONFIG_FIELDS, so a field
// the resolver drops (or answers from the wrong layer) fails it; the
// sabotage block proves that against a mutant that drops one field.
import { describe, expect, it } from "vitest";
import { SESSION_IDLE_SECONDS } from "../src/limits.ts";
import {
  ORG_COLUMN_FIELDS,
  PROJECT_FORBIDDEN_FIELDS,
  REGION_CONFIG_FIELDS,
  type EffectiveRegionConfig,
  type OrganizationLayer,
  type RegionConfigField,
  type RegionConfigLayer,
  type RegionConfigValues,
  type ResolveInput,
  PROJECT_COLUMN_FIELDS,
  ADAPTER_ID_PATTERN,
  PAYMENT_ADAPTERS_MAX,
  REFERENCE_ID_PATTERN,
  resolveRegionConfig,
} from "../src/region-config.ts";

type Resolve = (input: ResolveInput) => EffectiveRegionConfig;

const organization: OrganizationLayer = {
  country: "SL",
  currency: "SLE",
  language: "en",
  timezone: "Africa/Freetown",
  units: "metric",
};

/** A value per field the org row may hold, distinct from every default. */
const ORG_ROW: Required<RegionConfigLayer> = {
  currency: null,
  reportingCurrency: "USD",
  language: null,
  timezone: null,
  formatLocale: "en-GB",
  units: null,
  taxProfileId: "sl_gst",
  paymentAdapters: ["orange_money"],
  accountingAdapter: "xero",
  rateLibrary: "sl_2026",
  sessionIdleSeconds: 900,
};

/** A value per field a project row may hold, distinct from the org's. */
const PROJECT_ROW: Required<
  Omit<
    RegionConfigLayer,
    "sessionIdleSeconds" | "currency" | "reportingCurrency" | "timezone"
  >
> = {
  language: "fr",
  formatLocale: "fr-FR",
  units: "us_customary",
  taxProfileId: "ng_vat",
  paymentAdapters: ["mpesa", "stripe"],
  accountingAdapter: "quickbooks",
  rateLibrary: "ng_2026",
};

/** The project's own columns (P6-05 D8, C1), distinct from the org's. */
const PROJECT_COLUMNS = {
  currency: "USD",
  reportingCurrency: "EUR",
  timezone: "Africa/Lagos",
} as const;

/** What the system layer gives each field for `organization` alone. */
const SYSTEM: RegionConfigValues = {
  currency: "SLE",
  reportingCurrency: "SLE",
  language: "en",
  timezone: "Africa/Freetown",
  formatLocale: "en-SL",
  units: "metric",
  taxProfileId: null,
  paymentAdapters: [],
  accountingAdapter: null,
  rateLibrary: null,
  sessionIdleSeconds: SESSION_IDLE_SECONDS.max,
};

const isOrgColumn = (f: RegionConfigField) =>
  (ORG_COLUMN_FIELDS as readonly string[]).includes(f);
const projectForbidden = (f: RegionConfigField) =>
  (PROJECT_FORBIDDEN_FIELDS as readonly string[]).includes(f);
const isProjectColumn = (f: RegionConfigField) =>
  (PROJECT_COLUMN_FIELDS as readonly string[]).includes(f);

/**
 * Every field, from every layer: the throwing check the sabotage block runs
 * against the real resolver and a mutant.
 */
function checkEveryField(resolve: Resolve): void {
  const bare = resolve({ organization });
  const withOrg = resolve({ organization, org: ORG_ROW });
  const withProject = resolve({
    organization,
    org: ORG_ROW,
    project: PROJECT_ROW,
    projectColumns: PROJECT_COLUMNS,
  });
  for (const field of REGION_CONFIG_FIELDS) {
    const orgColumn = isOrgColumn(field);
    expect(bare[field], `${field} with no rows`).toEqual({
      value: SYSTEM[field],
      source: orgColumn ? "org" : "system",
    });
    expect(withOrg[field], `${field} with an org row`).toEqual(
      orgColumn
        ? { value: SYSTEM[field], source: "org" }
        : { value: ORG_ROW[field], source: "org" },
    );
    expect(withProject[field], `${field} with a project row`).toEqual(
      isProjectColumn(field)
        ? {
            value: PROJECT_COLUMNS[field as keyof typeof PROJECT_COLUMNS],
            source: "project",
          }
        : projectForbidden(field)
          ? { value: ORG_ROW[field], source: "org" }
          : {
              value: PROJECT_ROW[field as keyof typeof PROJECT_ROW],
              source: "project",
            },
    );
  }
  expect(Object.keys(withProject).sort()).toEqual(
    [...REGION_CONFIG_FIELDS].sort(),
  );
}

describe("the field list", () => {
  it("is exactly the ROADMAP's overridable fields plus the org idle timeout (P5 ruling D6)", () => {
    expect(REGION_CONFIG_FIELDS).toEqual([
      "currency",
      "reportingCurrency",
      "language",
      "timezone",
      "formatLocale",
      "units",
      "taxProfileId",
      "paymentAdapters",
      "accountingAdapter",
      "rateLibrary",
      "sessionIdleSeconds",
    ]);
    expect(Object.isFrozen(REGION_CONFIG_FIELDS)).toBe(true);
  });

  it("the organisation's own columns are the org layer for four fields (D8); the project's own columns the project layer for three (P6-05 C1); a project row never sets those nor the idle timeout (D10)", () => {
    expect(ORG_COLUMN_FIELDS).toEqual([
      "currency",
      "language",
      "timezone",
      "units",
    ]);
    expect(PROJECT_COLUMN_FIELDS).toEqual([
      "currency",
      "reportingCurrency",
      "timezone",
    ]);
    expect(PROJECT_FORBIDDEN_FIELDS).toEqual([
      "currency",
      "reportingCurrency",
      "timezone",
      "sessionIdleSeconds",
    ]);
    for (const f of [
      ...ORG_COLUMN_FIELDS,
      ...PROJECT_COLUMN_FIELDS,
      ...PROJECT_FORBIDDEN_FIELDS,
    ]) {
      expect(REGION_CONFIG_FIELDS).toContain(f);
    }
  });

  it("the idle bounds: one minute to the realm's 12 h (C2)", () => {
    expect(SESSION_IDLE_SECONDS).toEqual({ min: 60, max: 43_200 });
    expect(Object.isFrozen(SESSION_IDLE_SECONDS)).toBe(true);
  });
});

describe("resolveRegionConfig() (Done-when 1 and 2)", () => {
  it("gives value and provenance for every field from every layer", () => {
    checkEveryField(resolveRegionConfig);
  });

  it.each(REGION_CONFIG_FIELDS.filter((f) => !projectForbidden(f)))(
    "%s: project wins over org, which wins over system",
    (field) => {
      const project = {
        [field]: PROJECT_ROW[field as keyof typeof PROJECT_ROW],
      };
      expect(
        resolveRegionConfig({ organization, org: ORG_ROW, project })[field]
          .source,
      ).toBe("project");
    },
  );

  it.each(PROJECT_COLUMN_FIELDS)(
    "%s: the project's column wins over org; a project row's value is ignored (C1)",
    (field) => {
      const resolved = resolveRegionConfig({
        organization,
        org: ORG_ROW,
        project: { [field]: field === "timezone" ? "UTC" : "GBP" },
        projectColumns: PROJECT_COLUMNS,
      });
      expect(resolved[field]).toEqual({
        value: PROJECT_COLUMNS[field],
        source: "project",
      });
      const withoutColumns = resolveRegionConfig({
        organization,
        org: ORG_ROW,
        project: { [field]: field === "timezone" ? "UTC" : "GBP" },
      });
      expect(withoutColumns[field].source).not.toBe("project");
    },
  );

  it.each(REGION_CONFIG_FIELDS)("%s: null and absent both inherit", (field) => {
    const withNull = resolveRegionConfig({
      organization,
      org: { [field]: null },
      project: { [field]: null },
    });
    const absent = resolveRegionConfig({ organization });
    expect(withNull[field]).toEqual(absent[field]);
  });

  it("an org row's value for an organisation column is ignored: the column is the one source (D8)", () => {
    const resolved = resolveRegionConfig({
      organization,
      org: {
        currency: "EUR",
        language: "fr",
        timezone: "UTC",
        units: "us_customary",
      },
    });
    for (const f of ORG_COLUMN_FIELDS) {
      expect(resolved[f]).toEqual({ value: SYSTEM[f], source: "org" });
    }
  });

  it("a project row's idle timeout is ignored (D10)", () => {
    const project = { sessionIdleSeconds: 60 } as RegionConfigLayer;
    expect(
      resolveRegionConfig({ organization, project }).sessionIdleSeconds,
    ).toEqual({ value: SESSION_IDLE_SECONDS.max, source: "system" });
  });

  it("the derived system defaults follow the effective values (D9)", () => {
    const resolved = resolveRegionConfig({
      organization: { ...organization, currency: "NGN" },
      project: { language: "fr" },
    });
    expect(resolved.reportingCurrency).toEqual({
      value: "NGN",
      source: "system",
    });
    expect(resolved.formatLocale).toEqual({ value: "fr-SL", source: "system" });
  });

  it("the payment adapter list is a copy, not the caller's array", () => {
    const list = ["mpesa"];
    const resolved = resolveRegionConfig({
      organization,
      org: { paymentAdapters: list },
    });
    list.push("stripe");
    expect(resolved.paymentAdapters.value).toEqual(["mpesa"]);
    expect(Object.isFrozen(resolved.paymentAdapters.value)).toBe(true);
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it("an empty project payment list overrides the org's (empty is a value, not inherit)", () => {
    expect(
      resolveRegionConfig({
        organization,
        org: { paymentAdapters: ["mpesa"] },
        project: { paymentAdapters: [] },
      }).paymentAdapters,
    ).toEqual({ value: [], source: "project" });
  });
});

describe("id shapes (D4, D12)", () => {
  it.each(["mpesa", "orange_money", "a1", `a${"b".repeat(62)}`])(
    "an adapter id %s is accepted",
    (id) => {
      expect(ADAPTER_ID_PATTERN.test(id)).toBe(true);
    },
  );

  it.each(["", "a", "1abc", "Mpesa", "m-pesa", "m pesa", `a${"b".repeat(63)}`])(
    "an adapter id %j is refused",
    (id) => {
      expect(ADAPTER_ID_PATTERN.test(id)).toBe(false);
    },
  );

  it.each(["sl_gst", "0199e1d0-0000-7000-8000-000000000001", "v1.2", "x"])(
    "a reference id %s is accepted",
    (id) => {
      expect(REFERENCE_ID_PATTERN.test(id)).toBe(true);
    },
  );

  it.each(["", "-x", "Upper", "a b", `a${"b".repeat(64)}`])(
    "a reference id %j is refused",
    (id) => {
      expect(REFERENCE_ID_PATTERN.test(id)).toBe(false);
    },
  );

  it("at most 16 payment adapters", () => {
    expect(PAYMENT_ADAPTERS_MAX).toBe(16);
  });
});

describe("sabotage: a resolver that drops one field fails the generated suite", () => {
  const dropping =
    (dropped: RegionConfigField): Resolve =>
    (input) => {
      const real = resolveRegionConfig(input);
      return Object.fromEntries(
        Object.entries(real).filter(([k]) => k !== dropped),
      ) as unknown as EffectiveRegionConfig;
    };
  const projectBlind: Resolve = (input) =>
    resolveRegionConfig({ ...input, project: {} });

  it.each(REGION_CONFIG_FIELDS)("dropping %s is caught", (field) => {
    expect(() => {
      checkEveryField(dropping(field));
    }).toThrow();
  });

  it("ignoring the project layer is caught", () => {
    expect(() => {
      checkEveryField(projectBlind);
    }).toThrow();
  });
});
