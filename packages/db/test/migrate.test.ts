// The migrator's decisions without a database (P4-02, ADR 0052): plan()
// refuses any change to applied history; migrate() checks the folder
// before it connects and hides connection failures behind one code.
import { describe, expect, it } from "vitest";
import type { Migration } from "../src/journal.js";
import {
  MIGRATION_ROLE,
  MIGRATIONS_DIR,
  MigrationError,
  migrate,
  plan,
} from "../src/migrate.js";
import { writeMigrations } from "./fixture-migrations.js";

const m = (idx: number, tag: string, sha256 = `sha-${tag}`): Migration => ({
  idx,
  tag,
  sha256,
  statements: ["SELECT 1;"],
});
const row = (idx: number, tag: string, sha256 = `sha-${tag}`) => ({
  idx,
  tag,
  sha256,
});

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof MigrationError)
      return `${error.code}:${error.tag ?? ""}`;
    throw error;
  }
  return "none";
}

describe("plan", () => {
  const all = [m(0, "0000_a"), m(1, "0001_b"), m(2, "0002_c")];

  it("nothing applied: everything is pending, in order", () => {
    expect(plan(all, []).map((x) => x.tag)).toEqual([
      "0000_a",
      "0001_b",
      "0002_c",
    ]);
  });

  it("a prefix applied: the rest is pending", () => {
    expect(
      plan(all, [row(0, "0000_a"), row(1, "0001_b")]).map((x) => x.tag),
    ).toEqual(["0002_c"]);
  });

  it("everything applied: nothing is pending", () => {
    expect(
      plan(all, [row(0, "0000_a"), row(1, "0001_b"), row(2, "0002_c")]),
    ).toEqual([]);
  });

  it("an applied tag missing from the journal is applied_migration_removed", () => {
    expect(
      codeOf(() => plan(all.slice(0, 1), [row(0, "0000_a"), row(1, "0001_b")])),
    ).toBe("applied_migration_removed:0001_b");
  });

  it("an applied tag at another idx is applied_migration_reordered", () => {
    expect(
      codeOf(() =>
        plan(
          [m(0, "0001_b"), m(1, "0000_a")],
          [row(0, "0000_a"), row(1, "0001_b")],
        ),
      ),
    ).toBe("applied_migration_reordered:0000_a");
  });

  it("an applied migration with another hash is applied_migration_changed", () => {
    expect(
      codeOf(() => plan(all, [row(0, "0000_a"), row(1, "0001_b", "other")])),
    ).toBe("applied_migration_changed:0001_b");
  });

  it("a pending migration below the highest applied idx is gap_fill", () => {
    expect(codeOf(() => plan(all, [row(0, "0000_a"), row(2, "0002_c")]))).toBe(
      "gap_fill:0001_b",
    );
  });

  it("removal is reported before a hash change", () => {
    expect(
      codeOf(() =>
        plan([m(0, "0000_a", "x")], [row(0, "0000_a"), row(1, "0001_b")]),
      ),
    ).toBe("applied_migration_removed:0001_b");
  });
});

describe("migrate without a database", () => {
  const closedPort = {
    reveal: () => "postgres://bricx_owner:pw-123@127.0.0.1:1/bricx_dev",
  };

  it("runs as bricx_owner from this package's migrations folder", () => {
    expect(MIGRATION_ROLE).toBe("bricx_owner");
    expect(MIGRATIONS_DIR.replaceAll("\\", "/")).toMatch(
      /\/packages\/db\/migrations$/,
    );
  });

  it("a broken folder is refused before connecting", async () => {
    const dir = await writeMigrations([], { dialect: "mysql", entries: [] });
    await expect(migrate(closedPort, dir)).rejects.toMatchObject({
      code: "journal_invalid",
    });
  });

  it("an unreachable database is database_unavailable, with no URL or cause", async () => {
    const error = await migrate(closedPort, await writeMigrations([]), {
      connectTimeoutMs: 2_000,
    }).catch((e: unknown) => e);
    if (!(error instanceof MigrationError)) throw error;
    expect(error).toMatchObject({
      code: "database_unavailable",
      message: "migration refused: database_unavailable",
    });
    expect(String(error)).not.toContain("pw-123");
    expect(error.cause).toBeUndefined();
  });
});
