// The adapter registry (P6-04, ADR 0074; Done when 1 and 3, owner
// conditions C2 and C5):
// - every boot refusal of D7 has its code and the adapter's index, and its
//   message never holds the value that was refused;
// - the dev registry holds the six Null adapters (P6-06 adds null_email), the production one
//   nothing, and production refuses a Null adapter (D1, D8);
// - the built registry is frozen, and later changes to the input list do
//   not reach it (C5);
// - buildRegistry() takes the environment as an input: NODE_ENV in
//   process.env changes nothing, and the source never reads process.env
//   (C2).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ADAPTER_REGISTRY_ERROR_CODES,
  AdapterRegistryError,
  type AdapterRegistryErrorCode,
  buildRegistry,
  defaultAdapters,
} from "../src/registry.ts";
import { ADAPTER_KINDS, type AdapterDescriptor } from "../src/types.ts";

const ok = (over: Partial<AdapterDescriptor> = {}): AdapterDescriptor => ({
  id: "orange_money_sl",
  kind: "payment",
  countries: ["SL"],
  currencies: ["SLE"],
  ...over,
});

const refusal = (
  adapters: readonly AdapterDescriptor[],
  nodeEnv: "development" | "test" | "production" = "test",
): AdapterRegistryError => {
  try {
    buildRegistry(adapters, { nodeEnv });
  } catch (error) {
    if (error instanceof AdapterRegistryError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildRegistry() refusals (D7)", () => {
  const SECRET = "zz_sentinel_value_9431";
  const cases: [
    AdapterRegistryErrorCode,
    AdapterDescriptor,
    string, // the refused value, which the message must not hold
  ][] = [
    ["invalid_id", ok({ id: "Orange-Money" }), "Orange-Money"],
    ["invalid_id", ok({ id: "x" }), '"x"'],
    ["invalid_id", ok({ id: "" }), '""'],
    ["invalid_id", ok({ id: `a${"b".repeat(63)}` }), "bbbbbbbb"],
    ["no_capabilities", ok({ countries: [] }), "[]"],
    ["no_capabilities", ok({ currencies: [] }), "[]"],
    ["unknown_country", ok({ countries: ["SL", "QQ"] }), "QQ"],
    ["unknown_country", ok({ countries: ["sl"] }), "sl"],
    ["unknown_currency", ok({ currencies: ["SLE", "QQQ"] }), "QQQ"],
    // XXX is ISO 4217 but has no minor unit; SLL is historical.
    ["unknown_currency", ok({ currencies: ["XXX"] }), "XXX"],
    ["unknown_currency", ok({ currencies: ["SLL"] }), "SLL"],
    ["unknown_currency", ok({ currencies: ["usd"] }), "usd"],
  ];

  test.each(cases)(
    "%s: code and index, never the value",
    (code, adapter, value) => {
      const error = refusal([ok({ id: "first_ok" }), adapter]);
      expect(error.code).toBe(code);
      expect(error.index).toBe(1);
      expect(error.message).toBe(`adapter registry: ${code} at index 1`);
      expect(error.message).not.toContain(value);
      expect(error.name).toBe("AdapterRegistryError");
    },
  );

  test("duplicate_id across kinds, at the second use; the message has no id", () => {
    const error = refusal([
      ok({ id: SECRET }),
      ok({ id: "other_one" }),
      ok({ id: SECRET, kind: "sms" }),
    ]);
    expect(error.code).toBe("duplicate_id");
    expect(error.index).toBe(2);
    expect(error.message).not.toContain(SECRET);
  });

  test("null_in_production: any Null adapter in production, at its index", () => {
    const nulls = defaultAdapters("test");
    expect(nulls).toHaveLength(6);
    nulls.forEach((adapter, index) => {
      const error = refusal([ok(), adapter], "production");
      expect(error.code).toBe("null_in_production");
      expect(error.index).toBe(1);
      expect(index).toBeGreaterThanOrEqual(0);
    });
    // The same list outside production is fine.
    expect(() =>
      buildRegistry([ok(), ...nulls], { nodeEnv: "development" }),
    ).not.toThrow();
  });

  test("a real (non-Null) adapter is accepted in production", () => {
    const registry = buildRegistry([ok()], { nodeEnv: "production" });
    expect(registry.has("payment", "orange_money_sl")).toBe(true);
  });

  test("every code in ADAPTER_REGISTRY_ERROR_CODES is raised by a case above", () => {
    const raised = new Set<string>([
      ...cases.map(([code]) => code),
      "duplicate_id",
      "null_in_production",
    ]);
    expect([...ADAPTER_REGISTRY_ERROR_CODES].sort()).toEqual(
      [...raised].sort(),
    );
  });

  test("the first refusal wins: the list stops at the first broken adapter", () => {
    const error = refusal([
      ok({ id: "a_ok" }),
      ok({ id: "BAD" }),
      ok({ id: "c_ok", countries: ["QQ"] }),
    ]);
    expect(error).toMatchObject({ code: "invalid_id", index: 1 });
  });
});

describe("the default registries (D8)", () => {
  test("outside production: the six Null adapters, one of each kind", () => {
    for (const nodeEnv of ["development", "test"] as const) {
      const registry = buildRegistry(defaultAdapters(nodeEnv), { nodeEnv });
      expect(registry.nodeEnv).toBe(nodeEnv);
      expect(registry.has("payment", "null_payment")).toBe(true);
      expect(registry.has("tax", "null_tax")).toBe(true);
      expect(registry.has("accounting", "null_accounting")).toBe(true);
      expect(registry.has("sms", "null_sms")).toBe(true);
      expect(registry.has("fx", "null_fx")).toBe(true);
      expect(registry.has("email", "null_email")).toBe(true);
      for (const kind of ADAPTER_KINDS) {
        expect(registry.list(kind)).toHaveLength(1);
      }
    }
  });

  test("an id is known only for its own kind", () => {
    const registry = buildRegistry(defaultAdapters("test"), {
      nodeEnv: "test",
    });
    expect(registry.has("accounting", "null_payment")).toBe(false);
    expect(registry.has("payment", "null_accounting")).toBe(false);
    expect(registry.has("payment", "mpesa")).toBe(false);
  });

  test("production: nothing registered, and the empty registry is valid", () => {
    expect(defaultAdapters("production")).toEqual([]);
    const registry = buildRegistry(defaultAdapters("production"), {
      nodeEnv: "production",
    });
    for (const kind of ADAPTER_KINDS) {
      expect(registry.list(kind)).toEqual([]);
    }
    expect(registry.has("payment", "null_payment")).toBe(false);
  });
});

describe("a built registry is frozen (C5)", () => {
  test("the registry, its lists, descriptors and capability lists", () => {
    const registry = buildRegistry(defaultAdapters("test"), {
      nodeEnv: "test",
    });
    expect(Object.isFrozen(registry)).toBe(true);
    for (const kind of ADAPTER_KINDS) {
      const list = registry.list(kind);
      expect(Object.isFrozen(list)).toBe(true);
      for (const descriptor of list) {
        expect(Object.isFrozen(descriptor)).toBe(true);
        expect(Object.isFrozen(descriptor.countries)).toBe(true);
        expect(Object.isFrozen(descriptor.currencies)).toBe(true);
      }
    }
    const payments = registry.list("payment") as AdapterDescriptor[];
    expect(() => payments.push(ok())).toThrow(TypeError);
    expect(() => {
      (registry as { has: unknown }).has = () => true;
    }).toThrow(TypeError);
    expect(registry.has("payment", "orange_money_sl")).toBe(false);
  });

  test("changing the input list after the build changes nothing", () => {
    const countries = ["SL"];
    const input: AdapterDescriptor[] = [ok({ countries })];
    const registry = buildRegistry(input, { nodeEnv: "test" });
    input.push(ok({ id: "added_later" }));
    countries.push("NG");
    expect(registry.has("payment", "added_later")).toBe(false);
    expect(registry.list("payment")[0]?.countries).toEqual(["SL"]);
  });
});

describe("the environment is an explicit input (C2)", () => {
  test("NODE_ENV=production in process.env does not make a test build refuse Null adapters", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() =>
      buildRegistry(defaultAdapters("test"), { nodeEnv: "test" }),
    ).not.toThrow();
    expect(defaultAdapters("test")).toHaveLength(6);
  });

  test("NODE_ENV=development in process.env does not let a production build accept them", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(refusal(defaultAdapters("test"), "production").code).toBe(
      "null_in_production",
    );
  });

  test("no source file reads process or its env", () => {
    const srcDir = path.resolve(import.meta.dirname, "../src");
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
    expect(files.sort()).toEqual([
      "email.ts",
      "null.ts",
      "registry.ts",
      "types.ts",
    ]);
    for (const file of files) {
      const code = readFileSync(path.join(srcDir, file), "utf8")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("//"))
        .join("\n");
      expect(code, file).not.toMatch(/\bprocess\b/);
      expect(code, file).not.toMatch(/\benv\b/);
    }
  });
});
