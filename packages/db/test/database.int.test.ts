// P4-01: the ping against compose.yml's real Postgres (real init folder,
// bricx_app from .env.example), and close() releases every connection.
import {
  type BootstrappedPostgres,
  exampleValue,
  startPostgres,
  appDatabase,
} from "@bricx/db-bootstrap/stack";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { openDatabase } from "../src/database.js";

let pg: BootstrappedPostgres;
beforeAll(async () => {
  pg = await startPostgres();
});
afterAll(async () => {
  await pg.container.stop();
});

const appUrl = () => ({
  reveal: () =>
    `postgres://bricx_app:${exampleValue("BRICX_APP_PASSWORD")}@${pg.container.getHost()}:${String(pg.container.getMappedPort(5432))}/${appDatabase}`,
});

async function appConnections(): Promise<number> {
  const admin = await pg.admin();
  try {
    const result = await admin.query<{ n: string }>(
      "SELECT count(*) AS n FROM pg_stat_activity WHERE usename = 'bricx_app'",
    );
    return Number(result.rows[0]?.n ?? "-1");
  } finally {
    await admin.end();
  }
}

describe("openDatabase against the dev Postgres", () => {
  test("ping succeeds as bricx_app", async () => {
    const db = openDatabase(appUrl());
    await expect(db.ping()).resolves.toBeUndefined();
    expect(await appConnections()).toBeGreaterThan(0);
    await db.close();
    expect(await appConnections()).toBe(0);
  });

  test("a wrong password fails the ping", async () => {
    const db = openDatabase({
      reveal: () =>
        appUrl().reveal().replace(exampleValue("BRICX_APP_PASSWORD"), "wrong"),
    });
    await expect(db.ping()).rejects.toMatchObject({
      name: "DatabaseUnavailableError",
      message: "database unavailable",
    });
    await db.close();
  });
});
