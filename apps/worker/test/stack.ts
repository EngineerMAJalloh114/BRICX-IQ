// The dev stack's Postgres and Valkey for the worker's integration tests,
// from compose.yml's images: Postgres with the real init folder, migrated
// by the real migrator as bricx_owner; Valkey started with compose.yml's
// own command line (password and maxmemory-policy noeviction).
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  type BootstrappedPostgres,
  appDatabase,
  composeImage,
  exampleValue,
  rolePasswordKeys,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { migrate } from "@bricx/db/migrate";
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers";

type Role = keyof typeof rolePasswordKeys;

export interface Stack {
  postgres: BootstrappedPostgres;
  valkey: StartedTestContainer;
  /** A database URL for one of the bootstrap roles. */
  url(role: Role): string;
  /** The Valkey URL, with the password from .env.example. */
  valkeyUrl(): string;
  stop(): Promise<void>;
}

const composeFile = path.resolve(
  import.meta.dirname,
  "../../../infrastructure/docker/compose.yml",
);

/**
 * compose.yml's valkey command line, as a list: the `exec valkey-server ...`
 * string with $$VALKEY_PASSWORD resolved. A test that changed the command
 * here would no longer prove compose.yml's settings.
 */
export function composeValkeyCommand(password: string): string[] {
  const text = readFileSync(composeFile, "utf8");
  const match = /exec (valkey-server [^\n]*)/.exec(text);
  if (match?.[1] === undefined)
    throw new Error("compose.yml: no valkey command");
  return match[1]
    .trim()
    .split(/\s+/)
    .map((part) => (part === '"$$VALKEY_PASSWORD"' ? password : part));
}

export async function startStack(): Promise<Stack> {
  const password = exampleValue("VALKEY_PASSWORD");
  const [postgres, valkey] = await Promise.all([
    startPostgres(),
    new GenericContainer(composeImage("valkey"))
      .withCommand(composeValkeyCommand(password))
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
      .start(),
  ]);
  const url = (role: Role) =>
    `postgres://${role}:${exampleValue(rolePasswordKeys[role])}@${postgres.container.getHost()}:${String(postgres.container.getMappedPort(5432))}/${appDatabase}`;
  await migrate({ reveal: () => url("bricx_owner") });
  return {
    postgres,
    valkey,
    url,
    valkeyUrl: () =>
      `redis://default:${password}@${valkey.getHost()}:${String(valkey.getMappedPort(6379))}`,
    async stop() {
      await Promise.all([postgres.container.stop(), valkey.stop()]);
    },
  };
}
