// P2-02 Verify (ROADMAP, ADR 0035): the database bootstrap roles, against
// compose.yml's Postgres image with the REAL init folder mounted.
// Done when: bricx_app cannot CREATE TABLE and cannot bypass RLS.
import { execFileSync } from "node:child_process";
import { RYUK_IMAGE } from "@bricx/vitest-config";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { bootstrapProblems, createProbes, RLS_PROBE } from "../src/checks.js";
import {
  appDatabase,
  type BootstrappedPostgres,
  startPostgres,
} from "../src/stack.js";

let db: BootstrappedPostgres;

beforeAll(async () => {
  db = await startPostgres();
});

afterAll(async () => {
  await db.container.stop();
});

/** Runs SQL as the bootstrap superuser (sabotage and its revert). */
async function asAdmin(sql: string): Promise<void> {
  const admin = await db.admin();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

describe("database bootstrap roles (P2-02)", () => {
  test("publication powersync is created empty", async () => {
    const admin = await db.admin();
    try {
      const { rows } = await admin.query<{ n: string }>(
        "SELECT count(*) AS n FROM pg_publication_tables WHERE pubname = 'powersync'",
      );
      expect(rows[0]?.n).toBe("0");
    } finally {
      await admin.end();
    }
  });

  test("every bootstrap property holds", async () => {
    await createProbes(db);
    expect(await bootstrapProblems(db)).toEqual([]);
  });

  // Each sabotage breaks one property the way an edited init script would;
  // the checks must report it, and pass again once it is reverted.
  const sabotages = [
    {
      name: "bricx_app flipped to BYPASSRLS",
      apply: "ALTER ROLE bricx_app BYPASSRLS",
      revert: "ALTER ROLE bricx_app NOBYPASSRLS",
      reports: ["bricx_app: rolbypassrls", "bricx_app sees without app.org_id"],
    },
    {
      name: "CREATE granted to PUBLIC",
      apply: "GRANT CREATE ON SCHEMA bricx TO PUBLIC",
      revert: "REVOKE CREATE ON SCHEMA bricx FROM PUBLIC",
      reports: [
        "PUBLIC CREATE on schema bricx",
        "bricx_app cannot CREATE TABLE in bricx",
      ],
    },
    {
      name: "REVOKE ... FROM PUBLIC dropped (PUBLIC keeps CONNECT)",
      apply: `GRANT CONNECT ON DATABASE ${appDatabase} TO PUBLIC`,
      revert: `REVOKE CONNECT ON DATABASE ${appDatabase} FROM PUBLIC`,
      reports: [
        `PUBLIC CONNECT on database ${appDatabase}`,
        `powersync_storage_owner connects to database ${appDatabase}`,
      ],
    },
    {
      name: "powersync_repl granted an unpublished table",
      apply: `GRANT SELECT ON ${RLS_PROBE} TO powersync_repl`,
      revert: `REVOKE SELECT ON ${RLS_PROBE} FROM powersync_repl`,
      reports: [
        "powersync_repl table privileges",
        "powersync_repl reads an unpublished table",
      ],
    },
    {
      name: "powersync_repl without BYPASSRLS",
      apply: "ALTER ROLE powersync_repl NOBYPASSRLS",
      revert: "ALTER ROLE powersync_repl BYPASSRLS",
      reports: [
        "powersync_repl: rolbypassrls",
        "powersync_repl sees every org's rows in a published table",
      ],
    },
  ];
  test.each(sabotages)("sabotage is caught: $name", async (sabotage) => {
    await asAdmin(sabotage.apply);
    let problems: string[];
    try {
      problems = await bootstrapProblems(db);
    } finally {
      await asAdmin(sabotage.revert);
    }
    for (const report of sabotage.reports) {
      expect(problems.some((p) => p.startsWith(report))).toBe(true);
    }
    expect(await bootstrapProblems(db)).toEqual([]);
  });

  // `docker ps` prints repo:tag even for a container created from
  // repo:tag@sha256, so compare image IDs: every running Ryuk container
  // must run exactly the image the pinned digest resolves to.
  test("Testcontainers runs the pinned Ryuk image", () => {
    const docker = (...args: string[]) =>
      execFileSync("docker", args, { encoding: "utf8" }).trim();
    const ryuks = docker(
      "ps",
      "-q",
      "--filter",
      "label=org.testcontainers.ryuk=true",
    )
      .split("\n")
      .filter((id) => id !== "");
    expect(ryuks.length).toBeGreaterThan(0);
    const pinnedId = docker(
      "image",
      "inspect",
      RYUK_IMAGE,
      "--format",
      "{{.Id}}",
    );
    const runningIds = docker(
      "inspect",
      ...ryuks,
      "--format",
      "{{.Image}}",
    ).split("\n");
    expect(new Set(runningIds)).toEqual(new Set([pinnedId]));
    const digest = RYUK_IMAGE.slice(RYUK_IMAGE.indexOf("@") + 1);
    expect(
      docker("image", "inspect", pinnedId, "--format", "{{json .RepoDigests}}"),
    ).toContain(`testcontainers/ryuk@${digest}`);
  });
});
