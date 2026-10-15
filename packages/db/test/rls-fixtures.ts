// P4-04 (ADR 0054): the test-only fixture migrations under fixtures/rls,
// one table per policy shape in @bricx/permissions' rls.sql, and the
// folders the integration tests compose from them. The production journal
// (MIGRATIONS_DIR) never contains them (test/rls.test.ts); the production
// run (db:migrate) passes no folder, so it reads only that journal.
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BREAKPOINT, journalFor } from "./fixture-migrations.js";

export const FIXTURE_DIR = path.join(import.meta.dirname, "fixtures/rls");

/** Each fixture table and the resource whose policies it carries. */
export const FIXTURE_TABLES: Readonly<Record<string, string>> = Object.freeze({
  "bricx.fx_organization": "org.organization",
  "bricx.fx_org_member": "org.member",
  "bricx.fx_org_audit": "org.audit",
  "bricx.fx_project_member": "project.member",
  "bricx.fx_project_task": "project.task",
  "bricx.fx_project": "project.project",
});

interface Entry {
  readonly idx: number;
  readonly tag: string;
}

async function entriesOf(dir: string): Promise<Entry[]> {
  const parsed: unknown = JSON.parse(
    await readFile(path.join(dir, "meta/_journal.json"), "utf8"),
  );
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("entries" in parsed) ||
    !Array.isArray(parsed.entries)
  ) {
    throw new Error("not a journal");
  }
  const list: unknown[] = parsed.entries;
  return list.map((e) => {
    if (
      typeof e !== "object" ||
      e === null ||
      !("idx" in e) ||
      !("tag" in e) ||
      typeof e.idx !== "number" ||
      typeof e.tag !== "string"
    ) {
      throw new Error("not a journal entry");
    }
    return { idx: e.idx, tag: e.tag };
  });
}

/** The tags in a migrations folder's journal, in order. */
export async function tagsOf(dir: string): Promise<string[]> {
  return (await entriesOf(dir)).map((e) => e.tag);
}

/**
 * A new temp folder holding every migration of `dirs`, in order, plus
 * `extra` (idx, tag, statements) at the end.
 */
export async function composeMigrations(
  dirs: readonly string[],
  extra: readonly {
    idx: number;
    tag: string;
    statements: readonly string[];
  }[] = [],
): Promise<string> {
  const out = await mkdtemp(path.join(os.tmpdir(), "bricx-rls-migrations-"));
  await mkdir(path.join(out, "meta"));
  const all: Entry[] = [];
  for (const dir of dirs) {
    for (const entry of await entriesOf(dir)) {
      await cp(
        path.join(dir, `${entry.tag}.sql`),
        path.join(out, `${entry.tag}.sql`),
      );
      all.push(entry);
    }
  }
  for (const m of extra) {
    await writeFile(
      path.join(out, `${m.tag}.sql`),
      m.statements.join(BREAKPOINT),
    );
    all.push({ idx: m.idx, tag: m.tag });
  }
  await writeFile(
    path.join(out, "meta/_journal.json"),
    JSON.stringify(journalFor(all), null, 2),
  );
  return out;
}
