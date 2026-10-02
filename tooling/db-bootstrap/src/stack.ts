// Starts the dev stack's Postgres (and PowerSync) the way compose.yml does,
// for the integration tests: the image is read from compose.yml (no second
// copy of the image string), the REAL infrastructure/docker/postgres/init
// folder is bind-mounted read-only (not a copy), and role passwords come
// from .env.example. The bootstrap superuser is a throwaway test identity
// generated here; the dev stack's superuser variables are never read.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import pg from "pg";
import {
  GenericContainer,
  type StartedNetwork,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { composeServiceImage, envEntries } from "../../../scripts/guards.mjs";

export const repoRoot = path.resolve(import.meta.dirname, "../../..");
const dockerDir = path.join(repoRoot, "infrastructure/docker");
export const initDir = path.join(dockerDir, "postgres/init");
const composeText = readFileSync(path.join(dockerDir, "compose.yml"), "utf8");

/** The image compose.yml pins for a service (repo:tag@sha256:digest). */
export const composeImage = (service: string): string =>
  composeServiceImage(composeText, service);

/** Values from .env.example, the dev stack's only source of them. */
const example = envEntries(
  readFileSync(path.join(repoRoot, ".env.example"), "utf8"),
);
export function exampleValue(key: string): string {
  const line = example.get(key);
  if (line === undefined) throw new Error(`.env.example has no ${key}`);
  return line.slice(line.indexOf("=") + 1);
}

export const appDatabase = exampleValue("POSTGRES_DATABASE");
export const storageDatabase = "powersync_storage";

/** Role name → .env.example key holding its password. */
export const rolePasswordKeys = {
  bricx_owner: "BRICX_OWNER_PASSWORD",
  bricx_app: "BRICX_APP_PASSWORD",
  bricx_readonly: "BRICX_READONLY_PASSWORD",
  powersync_repl: "POWERSYNC_REPL_PASSWORD",
  powersync_storage_owner: "POWERSYNC_STORAGE_PASSWORD",
} as const;
export type Role = keyof typeof rolePasswordKeys;
export const roles = Object.keys(rolePasswordKeys) as Role[];

export interface BootstrappedPostgres {
  container: StartedPostgreSqlContainer;
  /** A new client as the throwaway bootstrap superuser. */
  admin(database?: string): Promise<pg.Client>;
  /** A new client as one of the bootstrap roles. */
  connectAs(role: Role, database?: string): Promise<pg.Client>;
}

/**
 * Postgres from compose.yml's image with the real init folder mounted.
 * With a network, it is reachable there as `postgres` (as in compose).
 */
export async function startPostgres(
  network?: StartedNetwork,
): Promise<BootstrappedPostgres> {
  const superuser = "bootstrap_test";
  const superPassword = randomBytes(16).toString("hex");
  let builder = new PostgreSqlContainer(composeImage("postgres"))
    .withDatabase(appDatabase)
    .withUsername(superuser)
    .withPassword(superPassword)
    .withCommand([
      "postgres",
      "-c",
      "wal_level=logical",
      "-c",
      "shared_preload_libraries=pg_stat_statements",
    ])
    .withEnvironment(
      Object.fromEntries(
        Object.values(rolePasswordKeys).map((key) => [key, exampleValue(key)]),
      ),
    )
    .withBindMounts([
      { source: initDir, target: "/docker-entrypoint-initdb.d", mode: "ro" },
    ]);
  if (network)
    builder = builder.withNetwork(network).withNetworkAliases("postgres");
  const container = await builder.start();
  const connect = async (user: string, password: string, database: string) => {
    const client = new pg.Client({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      user,
      password,
      database,
    });
    await client.connect();
    return client;
  };
  return {
    container,
    admin: (database = appDatabase) =>
      connect(superuser, superPassword, database),
    connectAs: (role, database = appDatabase) =>
      connect(role, exampleValue(rolePasswordKeys[role]), database),
  };
}

/**
 * PowerSync from compose.yml's image with the real healthcheck.mjs and the
 * given config (the real powersync.yaml unless a test passes its own), on
 * the network, connecting as compose.yml's powersync service does. No port
 * is published: the healthcheck runs inside the container.
 */
export async function startPowerSync(
  network: StartedNetwork,
  configPath = path.join(dockerDir, "powersync/powersync.yaml"),
): Promise<StartedTestContainer> {
  return new GenericContainer(composeImage("powersync"))
    .withNetwork(network)
    .withCommand(["start", "-r", "unified"])
    .withEnvironment({
      POWERSYNC_CONFIG_PATH: "/config/powersync.yaml",
      PS_DATA_SOURCE_URI: `postgresql://powersync_repl:${exampleValue("POWERSYNC_REPL_PASSWORD")}@postgres:5432/${appDatabase}`,
      PS_STORAGE_URI: `postgresql://powersync_storage_owner:${exampleValue("POWERSYNC_STORAGE_PASSWORD")}@postgres:5432/${storageDatabase}`,
      PS_API_TOKEN: exampleValue("POWERSYNC_API_TOKEN"),
    })
    .withBindMounts([
      { source: configPath, target: "/config/powersync.yaml", mode: "ro" },
      {
        source: path.join(dockerDir, "powersync/healthcheck.mjs"),
        target: "/config/healthcheck.mjs",
        mode: "ro",
      },
    ])
    .withWaitStrategy(Wait.forLogMessage("Running on port 8080"))
    .start();
}

/**
 * Polls `check` until it returns a value, or fails after `timeoutMs`.
 * Bounded polling only: no fixed sleeps.
 */
export async function waitFor<T>(
  what: string,
  check: () => Promise<T | undefined>,
  timeoutMs = 90_000,
  intervalMs = 500,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    if (performance.now() > deadline) {
      throw new Error(
        `timed out after ${String(timeoutMs)} ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
