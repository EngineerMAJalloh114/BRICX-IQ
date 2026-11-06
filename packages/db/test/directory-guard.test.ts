// P6-01 (ADR 0071): the directory migrator's guard and its refusals that
// need no database. The guard's queries against a real catalog are in
// directory-migrate.int.test.ts; here a fake client proves the order of
// the checks and that the first row found is the refusal.
import type pg from "pg";
import { describe, expect, test } from "vitest";
import {
  DIRECTORY_MIGRATIONS_DIR,
  DIRECTORY_MIGRATION_ROLE,
  MigrationError,
  directoryGuardProblem,
  migrateDirectory,
} from "../src/migrate.js";

/** A client whose n-th query answers `answers[n]` (no row past the end). */
function fakeClient(answers: (string | undefined)[]): {
  client: pg.Client;
  queries: string[];
} {
  const queries: string[] = [];
  const client = {
    query: (text: string) => {
      const answer = answers[queries.length];
      queries.push(text);
      return Promise.resolve({
        rows: answer === undefined ? [] : [{ relation: answer }],
      });
    },
  } as unknown as pg.Client;
  return { client, queries };
}

describe("directoryGuardProblem", () => {
  test("no problem: three checks run, undefined", async () => {
    const { client, queries } = fakeClient([]);
    expect(await directoryGuardProblem(client)).toBeUndefined();
    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain("relforcerowsecurity");
    expect(queries[1]).toContain("prosecdef");
    expect(queries[2]).toContain("aclexplode");
  });

  test.each([
    [0, "tenant_rls_missing", "directory.bad"],
    [1, "definer_forbidden", "directory.f()"],
    [2, "public_table_privilege", "directory.open"],
  ] as const)("check %i found: %s", async (index, code, relation) => {
    const answers: (string | undefined)[] = [undefined, undefined, undefined];
    answers[index] = relation;
    const { client, queries } = fakeClient(answers);
    expect(await directoryGuardProblem(client)).toEqual({ code, relation });
    expect(queries).toHaveLength(index + 1);
  });
});

describe("migrateDirectory without a database", () => {
  test("the role and the folder", () => {
    expect(DIRECTORY_MIGRATION_ROLE).toBe("directory_owner");
    expect(DIRECTORY_MIGRATIONS_DIR).toMatch(
      /packages\/db\/directory-migrations$/,
    );
  });

  test("a folder without a journal is journal_missing before any connection", async () => {
    let revealed = false;
    const url = {
      reveal: () => {
        revealed = true;
        return "postgres://directory_owner:x@127.0.0.1:1/bricx_directory";
      },
    };
    await expect(
      migrateDirectory(url, "/nonexistent/bricx/directory-migrations"),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof MigrationError && error.code === "journal_missing",
    );
    expect(revealed).toBe(false);
  });

  test("the real journal is readable and lists 0000_directory", async () => {
    let revealed = false;
    const url = {
      reveal: () => {
        revealed = true;
        return "postgres://directory_owner:x@127.0.0.1:1/bricx_directory";
      },
    };
    // Port 1 refuses: the folder was read (no journal error), then the
    // connection failed with no detail.
    await expect(
      migrateDirectory(url, DIRECTORY_MIGRATIONS_DIR, {
        connectTimeoutMs: 500,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof MigrationError &&
        error.code === "database_unavailable",
    );
    expect(revealed).toBe(true);
  });
});
