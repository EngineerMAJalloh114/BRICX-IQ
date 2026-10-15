// P4-02 (ADR 0052): the built migrate entry point, as `pnpm db:migrate`
// runs it, against compose.yml's Postgres. Prints "applied N" or "0
// applied"; exits 1 naming keys or codes only, never a URL or password.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  type BootstrappedPostgres,
  appDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const appDir = path.resolve(import.meta.dirname, "..");
const outDir = path.join(appDir, "dist");
let pg: BootstrappedPostgres;
beforeAll(async () => {
  execFileSync(
    process.execPath,
    [
      path.resolve(appDir, "../../node_modules/typescript/bin/tsc"),
      "-p",
      path.join(appDir, "tsconfig.build.json"),
    ],
    { cwd: appDir, stdio: "pipe" },
  );
  pg = await startPostgres();
});
afterAll(async () => {
  await pg.container.stop();
});

const url = (role: string, password: string) =>
  `postgres://${role}:${password}@${pg.container.getHost()}:${String(pg.container.getMappedPort(5432))}/${appDatabase}`;

function runMigrate(
  env: Record<string, string>,
): Promise<{ code: number | null; output: string }> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      path.join(outDir, "register.js"),
      path.join(outDir, "migrate.js"),
    ],
    {
      cwd: appDir,
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: "pipe",
    },
  );
  let output = "";
  child.stdout.on("data", (d: Buffer) => (output += d.toString("utf8")));
  child.stderr.on("data", (d: Buffer) => (output += d.toString("utf8")));
  return new Promise((resolve) => {
    child.on("close", (code) => {
      resolve({ code, output });
    });
  });
}

describe("the migrate entry point", () => {
  test("as bricx_owner: applies the real journal, then 0 applied", async () => {
    const env = {
      NODE_ENV: "development",
      MIGRATION_DATABASE_URL: url(
        "bricx_owner",
        exampleValue("BRICX_OWNER_PASSWORD"),
      ),
    };
    const first = await runMigrate(env);
    expect(first.code).toBe(0);
    expect(first.output).toMatch(/^db:migrate: (?:applied \d+|0 applied)/m);
    const second = await runMigrate(env);
    expect(second).toEqual({ code: 0, output: "db:migrate: 0 applied\n" });
  });

  // P4-04 condition 3: the production run reads only the production
  // journal (packages/db/migrations); the RLS fixture migrations under
  // packages/db/test/fixtures never reach a real database.
  test("the production run applies exactly the production journal and no fixture", async () => {
    const journal: unknown = JSON.parse(
      readFileSync(
        path.resolve(appDir, "../../packages/db/migrations/meta/_journal.json"),
        "utf8",
      ),
    );
    const tags =
      typeof journal === "object" &&
      journal !== null &&
      "entries" in journal &&
      Array.isArray(journal.entries)
        ? journal.entries.map((e: unknown) =>
            typeof e === "object" && e !== null && "tag" in e
              ? String(e.tag)
              : "",
          )
        : [];
    expect(tags).toContain("0000_rls_functions");
    const admin = await pg.admin();
    try {
      const applied = await admin.query<{ tag: string }>(
        "SELECT tag FROM bricx_migrations.applied ORDER BY idx",
      );
      expect(applied.rows.map((r) => r.tag)).toEqual(tags);
      const fixtures = await admin.query(
        `SELECT c.relname FROM pg_class c
          WHERE c.relnamespace IN ('bricx'::regnamespace, 'app'::regnamespace)
            AND c.relname LIKE 'fx\\_%'
         UNION ALL
         SELECT p.proname FROM pg_proc p
          WHERE p.pronamespace IN ('bricx'::regnamespace, 'app'::regnamespace)
            AND p.proname LIKE 'fx\\_%'`,
      );
      expect(fixtures.rows).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  test("a missing key exits 1 naming the key only", async () => {
    const result = await runMigrate({ NODE_ENV: "development" });
    expect(result.code).toBe(1);
    expect(result.output).toContain("MIGRATION_DATABASE_URL: missing");
  });

  test("the bricx_app URL exits 1 with wrong_role and no password", async () => {
    const password = exampleValue("BRICX_APP_PASSWORD");
    const result = await runMigrate({
      NODE_ENV: "development",
      MIGRATION_DATABASE_URL: url("bricx_app", password),
    });
    expect(result.code).toBe(1);
    expect(result.output).toBe("db:migrate: migration refused: wrong_role\n");
    expect(result.output).not.toContain(password);
  });

  test("an unreachable database exits 1 with database_unavailable only", async () => {
    const result = await runMigrate({
      NODE_ENV: "development",
      MIGRATION_DATABASE_URL: url("bricx_owner", "wrong-password-88"),
    });
    expect(result).toEqual({
      code: 1,
      output: "db:migrate: migration refused: database_unavailable\n",
    });
  });
});
