// P2-02 (ADR 0035, ruling D1): PowerSync's healthcheck proves replication
// works, not just that the process is alive. Postgres runs with the real
// init folder; PowerSync runs compose.yml's image with the real
// healthcheck.mjs. Bounded polling only, no fixed sleeps.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  Network,
  type StartedNetwork,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type BootstrappedPostgres,
  exampleValue,
  repoRoot,
  startPostgres,
  startPowerSync,
  storageDatabase,
  waitFor,
} from "../src/stack.js";

const token = exampleValue("POWERSYNC_API_TOKEN");
let network: StartedNetwork;
let db: BootstrappedPostgres;
const scratch = mkdtempSync(path.join(tmpdir(), "bricx-powersync-"));

beforeAll(async () => {
  network = await new Network().start();
  db = await startPostgres(network);
});

afterAll(async () => {
  await db.container.stop();
  await network.stop();
  rmSync(scratch, { recursive: true, force: true });
});

/** Runs the real healthcheck inside the container, as Docker does. */
async function health(powersync: StartedTestContainer) {
  const { exitCode, output } = await powersync.exec([
    "node",
    "/config/healthcheck.mjs",
  ]);
  // The healthcheck must never print the admin API token.
  expect(output).not.toContain(token);
  return { exitCode, output };
}

const healthy = (powersync: StartedTestContainer) =>
  waitFor("PowerSync healthy", async () => {
    const result = await health(powersync);
    return result.exitCode === 0 ? result.output : undefined;
  });

const unhealthy = (powersync: StartedTestContainer, reason: string) =>
  waitFor(`PowerSync unhealthy with ${reason}`, async () => {
    const result = await health(powersync);
    return result.exitCode === 1 && result.output.includes(reason)
      ? result.output
      : undefined;
  });

async function sql(
  text: string,
  as: "admin" | "bricx_owner" = "admin",
  database?: string,
) {
  const client =
    as === "admin"
      ? await db.admin(database)
      : await db.connectAs(as, database);
  try {
    return (await client.query(text)).rows as Record<string, unknown>[];
  } finally {
    await client.end();
  }
}

// What a recreated publication needs: an empty publication owned by
// bricx_owner (01-bootstrap.sh). The rule is to never drop it; the test
// drops it only to prove the healthcheck notices.
const restorePublication =
  "CREATE PUBLICATION powersync; ALTER PUBLICATION powersync OWNER TO bricx_owner";

describe("PowerSync replication healthcheck (P2-02)", () => {
  test("real config: healthy, unhealthy when the publication is dropped, healthy when it is restored", async () => {
    const powersync = await startPowerSync(network);
    try {
      expect(await healthy(powersync)).toContain(
        "healthy: replication connected",
      );

      await sql("DROP PUBLICATION powersync");
      expect(await unhealthy(powersync, "PSYNC_S1141")).toContain(
        "Publication 'powersync' does not exist",
      );
      // PostgreSQL 18 still reports the stream as healthy, which is why the
      // healthcheck asks PowerSync instead (ADR 0035).
      const replication = await sql(
        "SELECT state FROM pg_stat_replication WHERE usename = 'powersync_repl'",
      );
      expect(replication).toEqual([{ state: "streaming" }]);

      await sql(restorePublication);
      expect(await healthy(powersync)).toContain(
        "healthy: replication connected",
      );
    } finally {
      await powersync.stop();
    }
  });

  test("rows written while the publication is missing never replicate", async () => {
    await sql(
      `BEGIN;
       CREATE TABLE bricx.loss_probe (id uuid PRIMARY KEY DEFAULT uuidv7(), note text NOT NULL);
       GRANT SELECT ON bricx.loss_probe TO powersync_repl;
       ALTER PUBLICATION powersync ADD TABLE bricx.loss_probe;
       COMMIT`,
      "bricx_owner",
    );
    await sql("INSERT INTO bricx.loss_probe (note) VALUES ('before-drop')");

    // The real config with one sync rule for the probe table.
    const real = readFileSync(
      path.join(repoRoot, "infrastructure/docker/powersync/powersync.yaml"),
      "utf8",
    );
    const config = real.replace(
      /sync_config:[\s\S]*?(?=\ntelemetry:)/,
      "sync_config:\n  content: |\n    bucket_definitions:\n      probe:\n        data:\n          - SELECT * FROM bricx.loss_probe\n",
    );
    expect(config).toContain("SELECT * FROM bricx.loss_probe");
    const configPath = path.join(scratch, "powersync.yaml");
    writeFileSync(configPath, config);

    /** Notes PowerSync has stored for the probe table, sorted. */
    const replicated = async () => {
      const rows = await sql(
        `SELECT n FROM unnest(ARRAY['before-drop', 'while-dropped', 'after-restore']) AS n
         WHERE EXISTS (SELECT 1 FROM powersync.current_data
                       WHERE position(convert_to(n, 'UTF8') IN data) > 0)
         ORDER BY n`,
        "admin",
        storageDatabase,
      );
      return rows.map((r) => String(r["n"]));
    };

    const powersync = await startPowerSync(network, configPath);
    try {
      await healthy(powersync);
      await waitFor("before-drop replicated", async () =>
        (await replicated()).includes("before-drop") ? true : undefined,
      );

      await sql("DROP PUBLICATION powersync");
      await sql("INSERT INTO bricx.loss_probe (note) VALUES ('while-dropped')");
      await unhealthy(powersync, "PSYNC_S1141");
      await sql(restorePublication);
      await sql(
        "ALTER PUBLICATION powersync ADD TABLE bricx.loss_probe",
        "bricx_owner",
      );
      await sql("INSERT INTO bricx.loss_probe (note) VALUES ('after-restore')");
      await waitFor("after-restore replicated", async () =>
        (await replicated()).includes("after-restore") ? true : undefined,
      );

      // Replication went past the gap, and the row written in it is gone:
      // the source has 3 rows, PowerSync has 2.
      expect(await replicated()).toEqual(["after-restore", "before-drop"]);
      expect(
        await sql("SELECT count(*)::int AS n FROM bricx.loss_probe"),
      ).toEqual([{ n: 3 }]);
      await healthy(powersync);
    } finally {
      await powersync.stop();
    }
  });
});
