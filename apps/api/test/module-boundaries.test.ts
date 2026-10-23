// Module boundaries (CLAUDE.md rule 13; P5-07, ROADMAP Also from the PR #71
// review): an API module writes only its own tables. The memberships module
// ends a removed member's elevations through @bricx/db/access-grants, never
// by touching bricx.access_grants (the access-grants module's table) itself.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const MEMBERSHIPS = join(import.meta.dirname, "../src/modules/memberships");

async function sources(dir: string): Promise<Map<string, string>> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".ts")).sort();
  const out = new Map<string, string>();
  for (const f of files) out.set(f, await readFile(join(dir, f), "utf8"));
  return out;
}

describe("module boundaries (rule 13)", () => {
  test("the memberships module never names the access_grants table; it ends grants through @bricx/db/access-grants", async () => {
    const files = await sources(MEMBERSHIPS);
    expect(files.size).toBeGreaterThan(0);
    const naming = [...files]
      .filter(([, text]) => /\baccessGrants\b|bricx\.access_grants/.test(text))
      .map(([name]) => name);
    expect(naming).toEqual([]);
    // The module provides the function (ACCESS_GRANT_ENDER); the service
    // takes its type only.
    const importing = [...files]
      .filter(([, text]) =>
        /import\s*(?:type\s*)?\{[^}]*\bendAccessGrantsOf\b[^}]*\}\s*from\s*"@bricx\/db\/access-grants"/.test(
          text,
        ),
      )
      .map(([name]) => name);
    expect(importing).toEqual([
      "memberships.module.ts",
      "memberships.service.ts",
    ]);
  });
});

const SRC = join(import.meta.dirname, "../src");

async function allSources(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [k, v] of await allSources(path)) out.set(k, v);
    } else if (entry.name.endsWith(".ts")) {
      out.set(path.slice(SRC.length + 1), await readFile(path, "utf8"));
    }
  }
  return out;
}

describe("one ability builder (P5-07, D-I, DW2)", () => {
  test("buildAbility is imported and called only in common/auth/ability.ts", async () => {
    const files = await allSources(SRC);
    expect(files.size).toBeGreaterThan(20);
    const naming = [...files]
      .filter(([, text]) => /\bbuildAbility\b/.test(text))
      .map(([name]) => name);
    expect(naming).toEqual(["common/auth/ability.ts"]);
  });

  test("the authorization guard builds its ability through abilityFor (no second path)", async () => {
    const guard = await readFile(join(SRC, "common/auth/can.guard.ts"), "utf8");
    expect(guard).toMatch(/\babilityFor\(/);
    expect(guard).not.toMatch(/\bbuildAbility\b|\bparseGrants\b/);
  });
});
