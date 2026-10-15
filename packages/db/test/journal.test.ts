// The journal reader (P4-02, ADR 0052): drizzle-kit's meta/_journal.json
// plus NNNN_tag.sql files, split on the statement breakpoint. Every error
// is a code and at most a tag, never file content.
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MigrationError } from "../src/migration-error.js";
import { readMigrations } from "../src/journal.js";
import {
  BREAKPOINT,
  journalFor,
  writeMigrations,
} from "./fixture-migrations.js";

const two = [
  {
    idx: 0,
    tag: "0000_first",
    statements: [
      'CREATE TABLE "bricx"."a" ("id" uuid PRIMARY KEY NOT NULL);',
      'CREATE TABLE "bricx"."b" ("id" uuid PRIMARY KEY NOT NULL);',
    ],
  },
  {
    idx: 1,
    tag: "0001_second",
    statements: ['ALTER TABLE "bricx"."a" ADD COLUMN "n" integer;'],
  },
];

async function errorOf(run: () => Promise<unknown>): Promise<MigrationError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof MigrationError) return error;
    throw error;
  }
  throw new Error("expected a MigrationError");
}

describe("readMigrations", () => {
  it("reads entries in journal order with statements and SHA-256", async () => {
    const dir = await writeMigrations(two);
    const migrations = await readMigrations(dir);
    expect(migrations.map((m) => [m.idx, m.tag])).toEqual([
      [0, "0000_first"],
      [1, "0001_second"],
    ]);
    expect(migrations[0]?.statements).toEqual(two[0]?.statements);
    expect(migrations[1]?.statements).toEqual(two[1]?.statements);
    const bytes = await readFile(path.join(dir, "0000_first.sql"));
    expect(migrations[0]?.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(Object.isFrozen(migrations)).toBe(true);
    expect(Object.isFrozen(migrations[0])).toBe(true);
  });

  it("an empty journal is no migrations", async () => {
    expect(await readMigrations(await writeMigrations([]))).toEqual([]);
  });

  it("drops empty pieces around breakpoints and trims statements", async () => {
    const dir = await writeMigrations([
      {
        idx: 0,
        tag: "0000_x",
        statements: ["  SELECT 1;  ", "", "SELECT 2;\n"],
      },
    ]);
    const [only] = await readMigrations(dir);
    expect(only?.statements).toEqual(["SELECT 1;", "SELECT 2;"]);
  });

  it("allows a gap in idx (strictly increasing, not contiguous)", async () => {
    const dir = await writeMigrations([
      { idx: 0, tag: "0000_a", statements: ["SELECT 1;"] },
      { idx: 2, tag: "0002_c", statements: ["SELECT 3;"] },
    ]);
    expect((await readMigrations(dir)).map((m) => m.idx)).toEqual([0, 2]);
  });

  it("a missing journal is journal_missing", async () => {
    const dir = await writeMigrations(two);
    await rm(path.join(dir, "meta/_journal.json"));
    expect((await errorOf(() => readMigrations(dir))).code).toBe(
      "journal_missing",
    );
  });

  it.each([
    ["not JSON", "{ secret-value-42"],
    ["not an object", "[]"],
    ["wrong dialect", JSON.stringify({ ...journalFor([]), dialect: "mysql" })],
    [
      "entries not an array",
      JSON.stringify({ dialect: "postgresql", entries: {} }),
    ],
    [
      "idx not an integer",
      JSON.stringify(journalFor([{ idx: 0.5, tag: "0000_a" }])),
    ],
    ["negative idx", JSON.stringify(journalFor([{ idx: -1, tag: "0000_a" }]))],
    [
      "tag with a path",
      JSON.stringify(journalFor([{ idx: 0, tag: "../0000_a" }])),
    ],
    [
      "tag without the NNNN_ prefix",
      JSON.stringify(journalFor([{ idx: 0, tag: "first" }])),
    ],
    [
      "breakpoints off",
      JSON.stringify({
        ...journalFor([]),
        entries: [
          { idx: 0, version: "7", when: 1, tag: "0000_a", breakpoints: false },
        ],
      }),
    ],
  ])("%s is journal_invalid, without echoing the file", async (_name, text) => {
    const dir = await writeMigrations([]);
    await writeFile(path.join(dir, "meta/_journal.json"), text);
    const error = await errorOf(() => readMigrations(dir));
    expect(error.code).toBe("journal_invalid");
    expect(error.message).not.toContain("secret-value-42");
  });

  it.each([
    ["repeated", [0, 0]],
    ["decreasing", [1, 0]],
  ])("a %s idx is journal_order", async (_name, idxs) => {
    const dir = await writeMigrations([
      { idx: idxs[0] ?? 0, tag: "0000_a", statements: ["SELECT 1;"] },
      { idx: idxs[1] ?? 0, tag: "0001_b", statements: ["SELECT 2;"] },
    ]);
    const error = await errorOf(() => readMigrations(dir));
    expect(error.code).toBe("journal_order");
    expect(error.tag).toBe("0001_b");
  });

  it("a repeated tag is journal_invalid", async () => {
    const dir = await writeMigrations(
      [{ idx: 0, tag: "0000_a", statements: ["SELECT 1;"] }],
      journalFor([
        { idx: 0, tag: "0000_a" },
        { idx: 1, tag: "0000_a" },
      ]),
    );
    const error = await errorOf(() => readMigrations(dir));
    expect(error.code).toBe("journal_invalid");
    expect(error.tag).toBe("0000_a");
  });

  it("a journal entry without its file is migration_file_missing", async () => {
    const dir = await writeMigrations(two);
    await rm(path.join(dir, "0001_second.sql"));
    const error = await errorOf(() => readMigrations(dir));
    expect(error.code).toBe("migration_file_missing");
    expect(error.tag).toBe("0001_second");
  });

  it("a .sql file the journal does not list is migration_file_unlisted", async () => {
    const dir = await writeMigrations(two);
    await writeFile(path.join(dir, "0002_stray.sql"), "SELECT 1;");
    const error = await errorOf(() => readMigrations(dir));
    expect(error.code).toBe("migration_file_unlisted");
    expect(error.tag).toBe("0002_stray");
  });

  it("a file over the size bound is migration_too_large, before it is read", async () => {
    const dir = await writeMigrations(two);
    const error = await errorOf(() =>
      readMigrations(dir, { maxFileBytes: 10 }),
    );
    expect(error.code).toBe("migration_too_large");
    expect(error.tag).toBe("0000_first");
  });

  it("a journal over the size bound is journal_invalid", async () => {
    const dir = await writeMigrations(two);
    const error = await errorOf(() =>
      readMigrations(dir, { maxJournalBytes: 10 }),
    );
    expect(error.code).toBe("journal_invalid");
  });

  it("the breakpoint marker is drizzle-kit's", () => {
    expect(BREAKPOINT.trim()).toBe("--> statement-breakpoint");
  });
});

describe("MigrationError", () => {
  it("message names the code and the tag only", () => {
    const error = new MigrationError("applied_migration_changed", {
      tag: "0003_x",
    });
    expect(error.name).toBe("MigrationError");
    expect(error.message).toBe(
      "migration refused: applied_migration_changed (0003_x)",
    );
    expect(error.cause).toBeUndefined();
  });

  it("a failed statement carries its index, SQLSTATE and server message", () => {
    const error = new MigrationError("migration_failed", {
      tag: "0001_b",
      statement: 2,
      sqlState: "42P01",
      serverMessage: 'relation "bricx.nope" does not exist',
    });
    expect(error.message).toBe(
      'migration failed: 0001_b, statement 2: 42P01 relation "bricx.nope" does not exist',
    );
    expect(error).toMatchObject({ statement: 2, sqlState: "42P01" });
  });

  it("database_error carries the SQLSTATE and server message, no tag", () => {
    const error = new MigrationError("database_error", {
      sqlState: "42501",
      serverMessage: "permission denied for table applied",
    });
    expect(error.message).toBe(
      "database error: 42501 permission denied for table applied",
    );
    expect(new MigrationError("database_error").message).toBe(
      "database error: ?",
    );
  });

  it("database_unavailable has a fixed message", () => {
    expect(new MigrationError("database_unavailable").message).toBe(
      "migration refused: database_unavailable",
    );
  });
});
