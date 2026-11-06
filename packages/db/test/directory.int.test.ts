// P6-01 (ADR 0071; owner conditions C1, C2 and C3): @bricx/db/directory
// against compose.yml's Postgres with the real init folder and the real
// directory journal.
// - registerOrganization() is a reservation: `reserved` once, `existing`
//   for the same (org_id, slug, cell), a typed conflict when the slug
//   belongs to another organisation or the organisation is registered
//   differently, `unknown_cell` for a cell that does not exist; errors
//   carry the code only; two organisations racing for one slug get
//   exactly one reservation;
// - each handle runs only as its role (the reader as directory_reader,
//   the writer as directory_writer), never as the owner;
// - resolve() answers by slug and by verified domain, never an org id.
import {
  type BootstrappedPostgres,
  directoryDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import {
  DirectoryRegistrationError,
  DirectoryRoleError,
  type DirectoryReader,
  type DirectoryWriter,
  openDirectoryReader,
  openDirectoryWriter,
} from "../src/directory.js";
import { migrateDirectory } from "../src/migrate.js";

let pg18: BootstrappedPostgres;
const handles: { close(): Promise<void> }[] = [];

type Who = "directory_owner" | "directory_reader" | "directory_writer";
const passwordKey: Record<Who, string> = {
  directory_owner: "DIRECTORY_OWNER_PASSWORD",
  directory_reader: "DIRECTORY_READER_PASSWORD",
  directory_writer: "DIRECTORY_WRITER_PASSWORD",
};
const urlFor = (role: Who) => ({
  reveal: () =>
    `postgres://${role}:${exampleValue(passwordKey[role])}@${pg18.container.getHost()}:${String(pg18.container.getMappedPort(5432))}/${directoryDatabase}`,
});
const reader = (role: Who = "directory_reader"): DirectoryReader => {
  const handle = openDirectoryReader(urlFor(role));
  handles.push(handle);
  return handle;
};
const writer = (role: Who = "directory_writer"): DirectoryWriter => {
  const handle = openDirectoryWriter(urlFor(role));
  handles.push(handle);
  return handle;
};

const ORG_A = "0192d4a0-0000-7000-8000-0000000000a1";
const ORG_B = "0192d4a0-0000-7000-8000-0000000000b1";
const ORG_C = "0192d4a0-0000-7000-8000-0000000000c1";

beforeAll(async () => {
  pg18 = await startPostgres();
  await migrateDirectory(urlFor("directory_owner"));
  const owner = await pg18.connectAs("directory_owner", directoryDatabase);
  try {
    await owner.query(`INSERT INTO directory.cells (id, api_base_url, keycloak_url) VALUES
      ('af-south-1', 'https://api.af-south-1.bricx.invalid', 'https://id.af-south-1.bricx.invalid/realms/bricx'),
      ('eu-west-1', 'https://api.eu-west-1.bricx.invalid', 'https://id.eu-west-1.bricx.invalid/realms/bricx')`);
  } finally {
    await owner.end();
  }
});
afterAll(async () => {
  await Promise.allSettled(handles.map((h) => h.close()));
  await pg18.container.stop();
});
beforeEach(async () => {
  const owner = await pg18.connectAs("directory_owner", directoryDatabase);
  try {
    await owner.query("DELETE FROM directory.org_email_domains");
    await owner.query("DELETE FROM directory.org_directory");
  } finally {
    await owner.end();
  }
});

async function registrationError(
  run: () => Promise<unknown>,
): Promise<DirectoryRegistrationError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof DirectoryRegistrationError) return error;
    throw error;
  }
  throw new Error("expected a DirectoryRegistrationError");
}

describe("registerOrganization() is a reservation (C2)", () => {
  test("reserved once, existing for the same (org_id, slug, cell)", async () => {
    const w = writer();
    const input = { orgId: ORG_A, slug: "acme", cellId: "af-south-1" };
    expect(await w.registerOrganization(input)).toBe("reserved");
    expect(await w.registerOrganization(input)).toBe("existing");
    expect(await w.registerOrganization(input)).toBe("existing");
    expect(await reader().resolve({ orgSlug: "acme" })).toEqual({
      cell: "af-south-1",
      apiBaseUrl: "https://api.af-south-1.bricx.invalid",
      keycloakUrl: "https://id.af-south-1.bricx.invalid/realms/bricx",
    });
  });

  test("a slug another organisation holds is slug_taken; the holder keeps it", async () => {
    const w = writer();
    await w.registerOrganization({
      orgId: ORG_A,
      slug: "acme",
      cellId: "af-south-1",
    });
    for (const cellId of ["af-south-1", "eu-west-1"]) {
      const error = await registrationError(() =>
        w.registerOrganization({ orgId: ORG_B, slug: "acme", cellId }),
      );
      expect(error.code).toBe("slug_taken");
    }
    expect((await reader().resolve({ orgSlug: "acme" }))?.cell).toBe(
      "af-south-1",
    );
  });

  test("an organisation registered with another slug or cell is org_registered_differently", async () => {
    const w = writer();
    await w.registerOrganization({
      orgId: ORG_A,
      slug: "acme",
      cellId: "af-south-1",
    });
    for (const input of [
      { orgId: ORG_A, slug: "acme-two", cellId: "af-south-1" },
      { orgId: ORG_A, slug: "acme", cellId: "eu-west-1" },
      { orgId: ORG_A, slug: "acme-two", cellId: "eu-west-1" },
    ]) {
      const error = await registrationError(() =>
        w.registerOrganization(input),
      );
      expect(error.code).toBe("org_registered_differently");
    }
    expect(await reader().resolve({ orgSlug: "acme-two" })).toBeUndefined();
  });

  test("a cell that does not exist is unknown_cell, and nothing is reserved", async () => {
    const error = await registrationError(() =>
      writer().registerOrganization({
        orgId: ORG_A,
        slug: "acme",
        cellId: "us-east-1",
      }),
    );
    expect(error.code).toBe("unknown_cell");
    expect(await reader().resolve({ orgSlug: "acme" })).toBeUndefined();
  });

  test("malformed input is invalid_input before any query; errors never carry a value", async () => {
    const w = writer();
    for (const input of [
      { orgId: "not-a-uuid", slug: "acme", cellId: "af-south-1" },
      { orgId: ORG_A.toUpperCase(), slug: "acme", cellId: "af-south-1" },
      { orgId: ORG_A, slug: "Acme", cellId: "af-south-1" },
      { orgId: ORG_A, slug: "a".repeat(64), cellId: "af-south-1" },
      { orgId: ORG_A, slug: "acme", cellId: "Mars" },
      { orgId: ORG_A, slug: "acme", cellId: "x".repeat(10_000) },
    ]) {
      const error = await registrationError(() =>
        w.registerOrganization(input),
      );
      expect(error.code).toBe("invalid_input");
      for (const value of Object.values(input)) {
        expect(error.message).not.toContain(value);
      }
    }
    const taken = await (async () => {
      await w.registerOrganization({
        orgId: ORG_A,
        slug: "secret-slug",
        cellId: "af-south-1",
      });
      return registrationError(() =>
        w.registerOrganization({
          orgId: ORG_B,
          slug: "secret-slug",
          cellId: "af-south-1",
        }),
      );
    })();
    expect(taken.message).not.toContain("secret-slug");
    expect(taken.message).not.toContain(ORG_B);
  });

  test("two organisations racing for one slug: exactly one reservation", async () => {
    const results = await Promise.allSettled(
      [ORG_A, ORG_B, ORG_C].map((orgId) =>
        writer().registerOrganization({
          orgId,
          slug: "contested",
          cellId: "eu-west-1",
        }),
      ),
    );
    const reserved = results.filter(
      (r) => r.status === "fulfilled" && r.value === "reserved",
    );
    const taken = results.filter(
      (r) =>
        r.status === "rejected" &&
        r.reason instanceof DirectoryRegistrationError &&
        r.reason.code === "slug_taken",
    );
    expect([reserved.length, taken.length]).toEqual([1, 2]);
  });
});

describe("each handle runs only as its role (C1)", () => {
  test("the writer refuses the reader's and the owner's URL", async () => {
    for (const role of ["directory_reader", "directory_owner"] as const) {
      await expect(
        writer(role).registerOrganization({
          orgId: ORG_A,
          slug: "acme",
          cellId: "af-south-1",
        }),
      ).rejects.toBeInstanceOf(DirectoryRoleError);
    }
    expect(await reader().resolve({ orgSlug: "acme" })).toBeUndefined();
  });

  test("the reader refuses the writer's and the owner's URL", async () => {
    for (const role of ["directory_writer", "directory_owner"] as const) {
      await expect(
        reader(role).resolve({ orgSlug: "acme" }),
      ).rejects.toBeInstanceOf(DirectoryRoleError);
    }
  });

  test("ping answers on both handles", async () => {
    await expect(reader().ping()).resolves.toBeUndefined();
    await expect(writer().ping()).resolves.toBeUndefined();
  });
});

describe("resolve() (D5)", () => {
  beforeEach(async () => {
    await writer().registerOrganization({
      orgId: ORG_A,
      slug: "acme",
      cellId: "af-south-1",
    });
    await writer().registerOrganization({
      orgId: ORG_B,
      slug: "beta",
      cellId: "eu-west-1",
    });
    // Domains are seeded as directory_owner: P6-01 has no domain writer (C3).
    const owner = await pg18.connectAs("directory_owner", directoryDatabase);
    try {
      await owner.query(
        "INSERT INTO directory.org_email_domains (domain, org_id, verified_at) VALUES ('beta.example', $1, now())",
        [ORG_B],
      );
    } finally {
      await owner.end();
    }
  });

  test("by slug and by verified domain; unknown is undefined", async () => {
    const r = reader();
    expect(await r.resolve({ emailDomain: "beta.example" })).toEqual({
      cell: "eu-west-1",
      apiBaseUrl: "https://api.eu-west-1.bricx.invalid",
      keycloakUrl: "https://id.eu-west-1.bricx.invalid/realms/bricx",
    });
    expect(await r.resolve({ orgSlug: "beta" })).toEqual(
      await r.resolve({ emailDomain: "beta.example" }),
    );
    expect(await r.resolve({ orgSlug: "nobody" })).toBeUndefined();
    expect(await r.resolve({ emailDomain: "acme.example" })).toBeUndefined();
  });

  test("a malformed or oversized lookup is undefined without a query", async () => {
    const r = reader();
    for (const lookup of [
      { orgSlug: "Beta" },
      { orgSlug: "b".repeat(64) },
      { orgSlug: "beta' OR '1'='1" },
      { emailDomain: "BETA.EXAMPLE" },
      { emailDomain: "x".repeat(254) },
      { emailDomain: "localhost" },
    ]) {
      expect(await r.resolve(lookup)).toBeUndefined();
    }
  });
});
