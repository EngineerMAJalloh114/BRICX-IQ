// P6-02 (ADR 0072; owner ruling R2): ensureDevCells() against compose.yml's
// Postgres with the real init folder and the real directory journal.
// - the two launch cells are inserted once, as directory_owner; a second
//   run inserts nothing;
// - a cell row whose URLs differ is DevCellsError cell_drift (the cell id
//   only, never a URL) and the row is left as it was;
// - any role but directory_owner is refused before anything is written;
// - the release runbook (D4, R6): directory_owner deletes a reservation
//   that has no domain; a reservation with a domain is kept by the FK
//   (23503); a released slug can be reserved again.
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
import { DEV_CELLS, DevCellsError, ensureDevCells } from "../src/dev-cells.js";
import { openDirectoryWriter } from "../src/directory.js";
import { migrateDirectory } from "../src/migrate.js";

let pg18: BootstrappedPostgres;

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

async function ownerQuery<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const owner = await pg18.connectAs("directory_owner", directoryDatabase);
  try {
    const result = await owner.query(text, params);
    return result.rows as T[];
  } finally {
    await owner.end();
  }
}

const cells = () =>
  ownerQuery<{ id: string; api_base_url: string; keycloak_url: string }>(
    "SELECT id, api_base_url, keycloak_url FROM directory.cells ORDER BY id",
  );

const ORG_A = "0192d4a0-0000-7000-8000-0000000000a1";
const ORG_B = "0192d4a0-0000-7000-8000-0000000000b1";

beforeAll(async () => {
  pg18 = await startPostgres();
  await migrateDirectory(urlFor("directory_owner"));
});
afterAll(async () => {
  await pg18.container.stop();
});
beforeEach(async () => {
  await ownerQuery("DELETE FROM directory.org_email_domains");
  await ownerQuery("DELETE FROM directory.org_directory");
  await ownerQuery("DELETE FROM directory.cells");
});

describe("ensureDevCells() (R2)", () => {
  test("inserts both launch cells once; a second run inserts nothing", async () => {
    expect(await ensureDevCells(urlFor("directory_owner"))).toEqual({
      inserted: ["af-south-1", "eu-west-1"],
    });
    expect(await ensureDevCells(urlFor("directory_owner"))).toEqual({
      inserted: [],
    });
    expect(await cells()).toEqual(
      DEV_CELLS.map((c) => ({
        id: c.id,
        api_base_url: c.apiBaseUrl,
        keycloak_url: c.keycloakUrl,
      })),
    );
  });

  test("inserts only the missing cell", async () => {
    const [first] = DEV_CELLS;
    if (first === undefined) throw new Error("no dev cells");
    await ownerQuery(
      "INSERT INTO directory.cells (id, api_base_url, keycloak_url) VALUES ($1, $2, $3)",
      [first.id, first.apiBaseUrl, first.keycloakUrl],
    );
    expect(await ensureDevCells(urlFor("directory_owner"))).toEqual({
      inserted: ["eu-west-1"],
    });
  });

  test("a drifted cell is cell_drift, names only the id, and nothing changes", async () => {
    await ownerQuery(
      `INSERT INTO directory.cells (id, api_base_url, keycloak_url)
       VALUES ('eu-west-1', 'https://api.eu-west-1.bricx.invalid', 'https://id.eu-west-1.bricx.invalid/realms/bricx')`,
    );
    const error = await ensureDevCells(urlFor("directory_owner")).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DevCellsError);
    if (!(error instanceof DevCellsError)) throw new Error("unreachable");
    expect(error.code).toBe("cell_drift");
    expect(error.cell).toBe("eu-west-1");
    expect(error.name).toBe("DevCellsError");
    expect(error.message).not.toMatch(/https?:/);
    // One transaction: af-south-1 was not inserted either.
    expect(await cells()).toEqual([
      {
        id: "eu-west-1",
        api_base_url: "https://api.eu-west-1.bricx.invalid",
        keycloak_url: "https://id.eu-west-1.bricx.invalid/realms/bricx",
      },
    ]);
  });

  test.each(["directory_writer", "directory_reader"] as const)(
    "%s is refused and nothing is written",
    async (role) => {
      await expect(ensureDevCells(urlFor(role))).rejects.toThrow(
        "dev cells: wrong role",
      );
      expect(await cells()).toEqual([]);
    },
  );
});

describe("the release runbook as directory_owner (D4, R6)", () => {
  beforeEach(async () => {
    await ensureDevCells(urlFor("directory_owner"));
  });

  test("a reservation with no domain is deleted and its slug reserved again", async () => {
    const w = openDirectoryWriter(urlFor("directory_writer"));
    try {
      expect(
        await w.registerOrganization({
          orgId: ORG_A,
          slug: "acme",
          cellId: "af-south-1",
        }),
      ).toBe("reserved");
      const released = await ownerQuery(
        `DELETE FROM directory.org_directory
          WHERE org_id = $1
            AND NOT EXISTS (SELECT 1 FROM directory.org_email_domains d WHERE d.org_id = $1)
          RETURNING org_id`,
        [ORG_A],
      );
      expect(released).toEqual([{ org_id: ORG_A }]);
      expect(
        await w.registerOrganization({
          orgId: ORG_B,
          slug: "acme",
          cellId: "eu-west-1",
        }),
      ).toBe("reserved");
    } finally {
      await w.close();
    }
  });

  test("a reservation with a domain is kept by the foreign key (23503)", async () => {
    await ownerQuery(
      "INSERT INTO directory.org_directory (org_id, org_slug, cell_id) VALUES ($1, 'acme', 'af-south-1')",
      [ORG_A],
    );
    await ownerQuery(
      "INSERT INTO directory.org_email_domains (domain, org_id, verified_at) VALUES ('acme.example', $1, now())",
      [ORG_A],
    );
    await expect(
      ownerQuery("DELETE FROM directory.org_directory WHERE org_id = $1", [
        ORG_A,
      ]),
    ).rejects.toMatchObject({ code: "23503" });
    expect(
      await ownerQuery("SELECT org_slug FROM directory.org_directory"),
    ).toEqual([{ org_slug: "acme" }]);
  });
});
