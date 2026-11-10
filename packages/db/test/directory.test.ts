// P6-01 (ADR 0071; owner condition C3): @bricx/db/directory's public
// surface, without a database. P6-01 ships no function that writes a
// domain: the export list is pinned, so adding one is a reviewed change.
import { createServer } from "node:net";
import { inspect } from "node:util";
import { describe, expect, test } from "vitest";
import { DatabaseUnavailableError } from "../src/database.js";
import * as directory from "../src/directory.js";

describe("@bricx/db/directory exports (C3)", () => {
  test("exactly the pinned names: a reader, a writer of reservations, no domain writer", () => {
    expect(Object.keys(directory).sort()).toEqual(
      [
        // P6-06 (ADR 0077, D3): the cell id shape (the ?cell= lookup).
        "CELL_ID_MAX",
        "DIRECTORY_READER_ROLE",
        "DIRECTORY_WRITER_ROLE",
        "DirectoryRegistrationError",
        "DirectoryRoleError",
        "EMAIL_DOMAIN_MAX",
        "ORG_SLUG_MAX",
        "isCellId",
        "isEmailDomain",
        "isOrgSlug",
        "openDirectoryReader",
        "openDirectoryWriter",
      ].sort(),
    );
    expect(
      Object.keys(directory).filter(
        (n) => /domain/i.test(n) && /write|insert|add|register|verify/i.test(n),
      ),
    ).toEqual([]);
  });

  test("the shapes the table CHECKs enforce", () => {
    expect(directory.ORG_SLUG_MAX).toBe(63);
    expect(directory.EMAIL_DOMAIN_MAX).toBe(253);
    for (const ok of ["acme", "a1b", "acme-builders", "a".repeat(63)]) {
      expect([ok, directory.isOrgSlug(ok)]).toEqual([ok, true]);
    }
    for (const bad of [
      "ab",
      "Acme",
      "-acme",
      "acme-",
      "a".repeat(64),
      "ac me",
      "acmé",
      "",
    ]) {
      expect([bad, directory.isOrgSlug(bad)]).toEqual([bad, false]);
    }
    for (const ok of [
      "acme.example",
      "xn--bcher-kva.example",
      "a.b.c.example",
    ]) {
      expect([ok, directory.isEmailDomain(ok)]).toEqual([ok, true]);
    }
    for (const bad of [
      "localhost",
      "Acme.example",
      "acme.example.",
      "-a.example",
      "a..example",
      `${"a".repeat(250)}.com`,
      "",
    ]) {
      expect([bad, directory.isEmailDomain(bad)]).toEqual([bad, false]);
    }
  });

  test("errors carry a code and never a value", () => {
    const error = new directory.DirectoryRegistrationError("slug_taken");
    expect(error.code).toBe("slug_taken");
    expect(error.message).toBe("directory registration refused: slug_taken");
    expect(new directory.DirectoryRoleError().message).toBe(
      "directory transaction: wrong role",
    );
  });
});

// Without Docker: the handles never connect for a malformed input, a
// failure to connect never carries the URL or the password, and close()
// is final. The role check, READ ONLY and the queries are in
// directory.int.test.ts against a real Postgres.
const SENTINEL = "sentinel-directory-password-7d41";

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === "string") {
    throw new Error("no port");
  }
  return address.port;
}

const countingUrl = (port: number) => {
  const state = { reveals: 0 };
  return {
    state,
    url: {
      reveal: () => {
        state.reveals += 1;
        return `postgres://directory_reader:${SENTINEL}@127.0.0.1:${String(port)}/bricx_directory`;
      },
    },
  };
};

function expectNoSecret(error: unknown) {
  expect(error).toBeInstanceOf(DatabaseUnavailableError);
  for (const text of [
    String(error),
    JSON.stringify(error),
    inspect(error, { showHidden: true, depth: 5 }),
  ]) {
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain("127.0.0.1");
  }
}

describe("directory handles without a database", () => {
  test("the url is revealed once, when the pool is created", async () => {
    const { state, url } = countingUrl(await closedPort());
    const reader = directory.openDirectoryReader(url, { timeoutMs: 200 });
    const writer = directory.openDirectoryWriter(url, { timeoutMs: 200 });
    expect(state.reveals).toBe(2);
    await reader.close();
    await writer.close();
    expect(state.reveals).toBe(2);
  });

  test("an unreachable database is DatabaseUnavailableError with no secret", async () => {
    const { url } = countingUrl(await closedPort());
    const reader = directory.openDirectoryReader(url, { timeoutMs: 200 });
    const writer = directory.openDirectoryWriter(url, { timeoutMs: 200 });
    try {
      for (const run of [
        () => reader.ping(),
        () => reader.resolve({ orgSlug: "acme" }),
        () => reader.resolve({ emailDomain: "acme.example" }),
        () => writer.ping(),
        () =>
          writer.registerOrganization({
            orgId: "0192d4a0-0000-7000-8000-0000000000a1",
            slug: "acme",
            cellId: "af-south-1",
          }),
      ]) {
        let caught: unknown;
        try {
          await run();
        } catch (error) {
          caught = error;
        }
        expectNoSecret(caught);
      }
    } finally {
      await reader.close();
      await writer.close();
    }
  });

  test("a malformed lookup or registration never reaches the database", async () => {
    // A closed port: any connection attempt would be
    // DatabaseUnavailableError, so an answer proves no query ran.
    const { url } = countingUrl(await closedPort());
    const reader = directory.openDirectoryReader(url, { timeoutMs: 200 });
    const writer = directory.openDirectoryWriter(url, { timeoutMs: 200 });
    try {
      for (const lookup of [
        { orgSlug: "Acme" },
        { orgSlug: "a".repeat(10_000) },
        { emailDomain: "localhost" },
        { emailDomain: "x".repeat(10_000) },
      ]) {
        expect(await reader.resolve(lookup)).toBeUndefined();
      }
      for (const input of [
        { orgId: "x", slug: "acme", cellId: "af-south-1" },
        {
          orgId: "0192d4a0-0000-7000-8000-0000000000a1",
          slug: "-",
          cellId: "af-south-1",
        },
        {
          orgId: "0192d4a0-0000-7000-8000-0000000000a1",
          slug: "acme",
          cellId: "af-south-1-".repeat(5),
        },
      ]) {
        await expect(writer.registerOrganization(input)).rejects.toMatchObject({
          code: "invalid_input",
        });
      }
    } finally {
      await reader.close();
      await writer.close();
    }
  });

  test("after close() every call is DatabaseUnavailableError; close is idempotent", async () => {
    const { url } = countingUrl(await closedPort());
    const reader = directory.openDirectoryReader(url, { timeoutMs: 200 });
    await reader.close();
    await reader.close();
    await expect(reader.ping()).rejects.toBeInstanceOf(
      DatabaseUnavailableError,
    );
    await expect(reader.resolve({ orgSlug: "acme" })).rejects.toBeInstanceOf(
      DatabaseUnavailableError,
    );
  });

  test("DirectoryRoleError and DirectoryRegistrationError name themselves", () => {
    expect(new directory.DirectoryRoleError().name).toBe("DirectoryRoleError");
    expect(new directory.DirectoryRegistrationError("unknown_cell").name).toBe(
      "DirectoryRegistrationError",
    );
    expect(directory.DIRECTORY_READER_ROLE).toBe("directory_reader");
    expect(directory.DIRECTORY_WRITER_ROLE).toBe("directory_writer");
  });
});
