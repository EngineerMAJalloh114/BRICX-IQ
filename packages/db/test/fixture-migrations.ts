// Writes a drizzle-kit-shaped migrations folder (meta/_journal.json plus
// NNNN_tag.sql files) for the migrator tests.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface FixtureMigration {
  readonly idx: number;
  readonly tag: string;
  /** Statements, joined with drizzle-kit's breakpoint marker. */
  readonly statements: readonly string[];
}

export const BREAKPOINT = "\n--> statement-breakpoint\n";

/** The journal drizzle-kit 0.31 writes for these entries. */
export function journalFor(entries: readonly { idx: number; tag: string }[]) {
  return {
    version: "7",
    dialect: "postgresql",
    entries: entries.map(({ idx, tag }) => ({
      idx,
      version: "7",
      when: 1_792_000_000_000 + idx,
      tag,
      breakpoints: true,
    })),
  };
}

/** A new temp folder holding `migrations`; returns its path. */
export async function writeMigrations(
  migrations: readonly FixtureMigration[],
  journal: unknown = journalFor(migrations),
): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bricx-migrations-"));
  await mkdir(path.join(dir, "meta"));
  await writeFile(
    path.join(dir, "meta/_journal.json"),
    JSON.stringify(journal, null, 2),
  );
  for (const m of migrations) {
    await writeFile(
      path.join(dir, `${m.tag}.sql`),
      m.statements.join(BREAKPOINT),
    );
  }
  return dir;
}
