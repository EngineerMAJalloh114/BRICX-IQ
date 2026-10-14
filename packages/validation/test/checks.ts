// Behaviour checks shared by the real tests and the sabotage tests: each
// passes on the real implementation and must fail on its mutant in
// mutants.ts (P3 rule 1).
import { expect, vi } from "vitest";
import type { z } from "zod";

type Schema = z.ZodType;

// Labels never serialise the input: JSON.stringify would read getters that
// checkGeo counts.
const label = (input: unknown) =>
  typeof input === "string" ? JSON.stringify(input) : typeof input;

const ok = (schema: Schema, input: unknown): unknown => {
  const result = schema.safeParse(input);
  expect(result.success, `accepts ${label(input)}`).toBe(true);
  return result.success ? result.data : undefined;
};
const rejects = (schema: Schema, input: unknown) => {
  expect(schema.safeParse(input).success, `rejects ${label(input)}`).toBe(
    false,
  );
};

export function checkEmail(schema: Schema): void {
  expect(ok(schema, "First.Last@Example.COM")).toBe("first.last@example.com");
  rejects(schema, " a@example.com");
  rejects(schema, "a@example.com\n");
}

export function checkPhone(schema: Schema): void {
  rejects(schema, "+12");
  expect(ok(schema, "+1234567")).toBe("+1234567");
  rejects(schema, "+232 76 123456");
  rejects(schema, "+1-202-555-0123");
}

export function checkCountry(schema: Schema): void {
  expect(ok(schema, "SL")).toBe("SL");
  rejects(schema, "sl");
  rejects(schema, "XK");
}

export function checkTimeZone(schema: Schema): void {
  expect(ok(schema, "UTC")).toBe("Etc/UTC");
  expect(ok(schema, "Asia/Calcutta")).toBe("Asia/Kolkata");
  expect(ok(schema, "Europe/London")).toBe("Europe/London");
}

export type ResolveLinks = (
  zones: readonly string[],
  links: readonly (readonly [target: string, name: string])[],
) => ReadonlyMap<string, string>;

export function checkLinkResolution(resolve: ResolveLinks): void {
  const map = resolve(
    ["Region/Real"],
    [
      ["Region/Real", "Region/Old"],
      ["Region/Old", "Region/Older"],
      ["Region/Older", "Region/Oldest"],
    ],
  );
  expect(map.get("Region/Oldest")).toBe("Region/Real");
  expect(map.get("Region/Older")).toBe("Region/Real");
  expect(() =>
    resolve(
      ["Z"],
      [
        ["A", "B"],
        ["B", "A"],
      ],
    ),
  ).toThrow();
}

export type BuildEnvelope = (
  schema: Schema,
  input: unknown,
) =>
  | {
      issues?: readonly {
        path: readonly (string | number)[];
        code: string;
      }[];
    }
  | undefined;

export function checkEnvelope(
  build: BuildEnvelope,
  recordSchema: Schema,
): void {
  // A made-up secret, not shaped like any provider's key (gitleaks scans tests).
  const secret = "attacker-secret-DO-NOT-LEAK-7f3a9c41";
  const envelope = build(recordSchema, { labels: { [secret]: 1 } });
  expect(envelope).toBeDefined();
  const json = JSON.stringify(envelope);
  expect(json.includes(secret)).toBe(false);
  expect(json).not.toMatch(/Invalid input|expected|received/);
  expect(envelope?.issues?.[0]?.path).toEqual(["labels", "*"]);
}

export function checkWorkDone(
  schema: Schema,
  format: { check: (value: string) => boolean },
): void {
  const spy = vi.spyOn(format, "check");
  try {
    rejects(schema, "a".repeat(1_000_000));
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
}

export function checkLocaleNoText(schema: Schema): void {
  const result = schema.safeParse("en_GB");
  expect(result.success).toBe(false);
  expect(JSON.stringify(result.error)).not.toMatch(/BCP 47|well-formed/);
}

export function checkPageLimit(schema: Schema): void {
  expect(ok(schema, undefined)).toBe(25);
  expect(ok(schema, "50")).toBe(50);
  for (const bad of ["1e1", " 5", "", "0x10", null, "025"])
    rejects(schema, bad);
}

export function checkGeo(schema: Schema): void {
  const point = ok(schema, { lat: -0, lng: 1 });
  expect(
    typeof point === "object" &&
      point !== null &&
      "lat" in point &&
      Object.is(point.lat, 0),
  ).toBe(true);
  let reads = 0;
  const big: Record<string, unknown> = {};
  Object.defineProperty(big, "lat", {
    enumerable: true,
    get() {
      reads += 1;
      return 0;
    },
  });
  for (let i = 0; i < 10_000; i += 1) big[`k${String(i)}`] = i;
  rejects(schema, big);
  expect(reads).toBe(0);
}
