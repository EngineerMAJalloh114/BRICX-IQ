// P6-01 (ADR 0071; owner condition C3): @bricx/db/directory's public
// surface, without a database. P6-01 ships no function that writes a
// domain: the export list is pinned, so adding one is a reviewed change.
import { describe, expect, test } from "vitest";
import * as directory from "../src/directory.js";

describe("@bricx/db/directory exports (C3)", () => {
  test("exactly the pinned names: a reader, a writer of reservations, no domain writer", () => {
    expect(Object.keys(directory).sort()).toEqual(
      [
        "DIRECTORY_READER_ROLE",
        "DIRECTORY_WRITER_ROLE",
        "DirectoryRegistrationError",
        "DirectoryRoleError",
        "EMAIL_DOMAIN_MAX",
        "ORG_SLUG_MAX",
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
