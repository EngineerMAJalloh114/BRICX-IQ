// Reads drizzle-kit's output (P4-02, ADR 0052): meta/_journal.json lists
// the migrations in order; each NNNN_tag.sql holds statements separated by
// "--> statement-breakpoint". Inputs are bounded before they are read,
// and every error is a code and at most a tag.
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { MigrationError } from "./migration-error.js";

export interface Migration {
  /** Journal position: strictly increasing, gaps allowed. */
  readonly idx: number;
  readonly tag: string;
  /** SHA-256 (hex) of the file's bytes, recorded when it is applied. */
  readonly sha256: string;
  readonly statements: readonly string[];
}

export interface ReadLimits {
  /** Largest migration file accepted, in bytes (default 8 MiB). */
  readonly maxFileBytes?: number;
  /** Largest journal accepted, in bytes (default 1 MiB). */
  readonly maxJournalBytes?: number;
}

const BREAKPOINT = "--> statement-breakpoint";
const TAG = /^\d{4}_[A-Za-z0-9_-]{1,100}$/;
const MiB = 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function sizeOf(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).size;
  } catch {
    return undefined;
  }
}

/** The journal's entries as { idx, tag }, validated. */
async function readJournal(
  folder: string,
  maxBytes: number,
): Promise<{ idx: number; tag: string }[]> {
  const file = path.join(folder, "meta", "_journal.json");
  const size = await sizeOf(file);
  if (size === undefined) throw new MigrationError("journal_missing");
  if (size > maxBytes) throw new MigrationError("journal_invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new MigrationError("journal_invalid");
  }
  if (
    !isRecord(parsed) ||
    parsed.dialect !== "postgresql" ||
    !Array.isArray(parsed.entries)
  ) {
    throw new MigrationError("journal_invalid");
  }
  const entries: { idx: number; tag: string }[] = [];
  const seen = new Set<string>();
  const list: unknown[] = parsed.entries;
  for (const entry of list) {
    if (
      !isRecord(entry) ||
      typeof entry.idx !== "number" ||
      !Number.isSafeInteger(entry.idx) ||
      entry.idx < 0 ||
      typeof entry.tag !== "string" ||
      !TAG.test(entry.tag) ||
      entry.breakpoints !== true
    ) {
      throw new MigrationError("journal_invalid");
    }
    const { idx, tag } = entry;
    if (seen.has(tag)) throw new MigrationError("journal_invalid", { tag });
    const previous = entries.at(-1);
    if (previous !== undefined && idx <= previous.idx) {
      throw new MigrationError("journal_order", { tag });
    }
    seen.add(tag);
    entries.push({ idx, tag });
  }
  return entries;
}

/**
 * Every migration in `folder`, in journal order. Throws MigrationError
 * when the journal is missing or malformed, an entry has no file, a .sql
 * file is not in the journal, or a file is over the size bound.
 */
export async function readMigrations(
  folder: string,
  limits: ReadLimits = {},
): Promise<readonly Migration[]> {
  const maxFileBytes = limits.maxFileBytes ?? 8 * MiB;
  const entries = await readJournal(folder, limits.maxJournalBytes ?? MiB);
  const listed = new Set(entries.map((e) => `${e.tag}.sql`));
  for (const name of (await readdir(folder)).sort()) {
    if (name.endsWith(".sql") && !listed.has(name)) {
      throw new MigrationError("migration_file_unlisted", {
        tag: name.slice(0, -".sql".length),
      });
    }
  }
  const migrations: Migration[] = [];
  for (const { idx, tag } of entries) {
    const file = path.join(folder, `${tag}.sql`);
    const size = await sizeOf(file);
    if (size === undefined) {
      throw new MigrationError("migration_file_missing", { tag });
    }
    if (size > maxFileBytes) {
      throw new MigrationError("migration_too_large", { tag });
    }
    const bytes = await readFile(file);
    const statements = bytes
      .toString("utf8")
      .split(BREAKPOINT)
      .map((s) => s.trim())
      .filter((s) => s !== "");
    migrations.push(
      Object.freeze({
        idx,
        tag,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        statements: Object.freeze(statements),
      }),
    );
  }
  return Object.freeze(migrations);
}
