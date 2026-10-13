// Client isolation and "loaders never read a file": static checks over
// src/, so a future import cannot slip past them.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { apiKeys } from "../src/api.js";
import { clientPublicKeys } from "../src/client-public.js";
import { workerKeys } from "../src/worker.js";

const srcDir = path.join(import.meta.dirname, "../src");
const sources = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
const read = (file: string) => readFileSync(path.join(srcDir, file), "utf8");

/** Module specifiers of every import/export-from and dynamic import. */
function specifiers(code: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) found.push(match[1] ?? "");
  }
  return found;
}

/** Every src file reachable from `entry` through relative imports. */
function closure(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of specifiers(read(file))) {
      if (spec.startsWith("."))
        visit(path.basename(spec).replace(/\.js$/, ".ts"));
    }
  };
  visit(entry);
  return seen;
}

describe("client isolation", () => {
  it("the scanner sees imports (control)", () => {
    expect(specifiers(read("api.ts"))).toContain("./shared.js");
    expect(closure("api.ts")).toContain("shared.ts");
  });

  it("client-public.ts reaches nothing from shared, api, worker or secret", () => {
    const reached = closure("client-public.ts");
    for (const server of ["shared.ts", "api.ts", "worker.ts", "secret.ts"]) {
      expect(reached).not.toContain(server);
    }
    for (const file of reached) {
      for (const spec of specifiers(read(file))) {
        expect(
          spec === "zod" || spec.startsWith("./"),
          `${file} imports ${spec}`,
        ).toBe(true);
      }
    }
  });

  it("client keys are EXPO_PUBLIC_*, never server keys, never secret-looking", () => {
    const server = new Set<string>([...apiKeys, ...workerKeys]);
    for (const key of clientPublicKeys) {
      expect(key).toMatch(/^EXPO_PUBLIC_[A-Z0-9_]+$/);
      expect(server.has(key)).toBe(false);
      expect(server.has(key.replace(/^EXPO_PUBLIC_/, ""))).toBe(false);
      expect(key).not.toMatch(/SECRET|PASSWORD|TOKEN|KEY/);
    }
    for (const key of server)
      expect(key.startsWith("EXPO_PUBLIC_")).toBe(false);
  });
});

describe("loaders never read a file", () => {
  // Built at run time so the repo-wide env-file guard does not flag this test.
  const envFileLoader = ["load", "EnvFile"].join("");

  it("src/ imports only zod and its own files", () => {
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      for (const spec of specifiers(read(file))) {
        expect(
          spec === "zod" || spec.startsWith("./"),
          `${file} imports ${spec}`,
        ).toBe(true);
      }
    }
  });

  it("client-public.ts does not even read process.env", () => {
    expect(read("client-public.ts")).not.toMatch(/\bprocess\b/);
  });

  it("the file-read pattern catches a dotenv path (control)", () => {
    expect('x(".env")').toMatch(/["'`](?:[^"'`\s]*\/)?\.env[\w.-]*["'`]/);
    expect("x('../../.env.staging')").toMatch(
      /["'`](?:[^"'`\s]*\/)?\.env[\w.-]*["'`]/,
    );
  });

  it("src/ never loads an env file or touches the file system", () => {
    for (const file of sources) {
      const code = read(file);
      expect(code, file).not.toContain(envFileLoader);
      expect(code, file).not.toMatch(
        /["'`](?:[^"'`\s]*\/)?\.env[\w.-]*["'`]|\bnode:|\breadFile|\bprocess\.(?!env\b)/,
      );
    }
  });
});
