// P6-02 (ADR 0072; owner ruling R2): when db:migrate may insert the dev
// cells, and that DEV_CELLS satisfies directory.cells' CHECKs (copied
// here from directory migration 0000 and pinned to its text).
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { DEV_CELLS, DevCellsError, devCellsAllowed } from "../src/dev-cells.js";

const url = (text: string) => ({ reveal: () => text });

describe("devCellsAllowed()", () => {
  test.each([
    ["postgres://directory_owner:x@localhost:5432/bricx_directory"],
    ["postgres://directory_owner:x@127.0.0.1:5432/bricx_directory"],
    ["postgres://directory_owner:x@[::1]:5432/bricx_directory"],
    ["postgres://directory_owner:x@LOCALHOST/bricx_directory"],
  ])("development and a local host: %s", (text) => {
    expect(devCellsAllowed("development", url(text))).toBe(true);
  });

  test.each([
    ["production", "postgres://o:x@localhost/bricx_directory"],
    ["test", "postgres://o:x@localhost/bricx_directory"],
    [undefined, "postgres://o:x@localhost/bricx_directory"],
    ["Development", "postgres://o:x@localhost/bricx_directory"],
    ["development", "postgres://o:x@db.internal/bricx_directory"],
    ["development", "postgres://o:x@10.0.0.5/bricx_directory"],
    ["development", "postgres://o:x@localhost.example.com/bricx_directory"],
    ["development", "not a url"],
    ["development", ""],
  ])("refused: NODE_ENV %s, %s", (nodeEnv, text) => {
    expect(devCellsAllowed(nodeEnv, url(text))).toBe(false);
  });
});

describe("DEV_CELLS", () => {
  const migration = readFileSync(
    new URL("../directory-migrations/0000_directory.sql", import.meta.url),
    "utf8",
  );
  const ID = "^[a-z]{2}(-[a-z]+)+-[0-9]+$";
  const API = "^https?://[a-z0-9.-]+(:[0-9]{1,5})?$";
  const KEYCLOAK = "^https?://[a-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~-]+)*$";

  test("the CHECK patterns copied here are the migration's", () => {
    for (const pattern of [ID, API, KEYCLOAK]) {
      expect(migration).toContain(`'${pattern}'`);
    }
  });

  test("are the two launch cells (ADR 0071), frozen", () => {
    expect(DEV_CELLS.map((c) => c.id)).toEqual(["af-south-1", "eu-west-1"]);
    expect(Object.isFrozen(DEV_CELLS)).toBe(true);
    for (const cell of DEV_CELLS) expect(Object.isFrozen(cell)).toBe(true);
  });

  test("every row satisfies directory.cells' CHECKs", () => {
    for (const cell of DEV_CELLS) {
      expect(cell.id).toMatch(new RegExp(ID));
      expect(cell.id.length).toBeLessThanOrEqual(32);
      expect(cell.apiBaseUrl).toMatch(new RegExp(API));
      expect(cell.apiBaseUrl.length).toBeLessThanOrEqual(255);
      expect(cell.keycloakUrl).toMatch(new RegExp(KEYCLOAK));
      expect(cell.keycloakUrl.length).toBeLessThanOrEqual(255);
    }
  });
});

describe("DevCellsError", () => {
  test("carries the code and the cell id only", () => {
    const error = new DevCellsError("cell_drift", "eu-west-1");
    expect(error.name).toBe("DevCellsError");
    expect(error.message).toBe("dev cells: cell_drift (eu-west-1)");
    expect(error.code).toBe("cell_drift");
    expect(error.cell).toBe("eu-west-1");
  });
});
