// The dev stack's Postgres and Valkey for the worker's integration tests,
// from compose.yml's images: Postgres with the real init folder, migrated
// by the real migrator as bricx_owner; Valkey started with compose.yml's
// own command line (password and maxmemory-policy noeviction), shared with
// the API's tests through @bricx/db-bootstrap/stack (P5-04).
import {
  type BootstrappedPostgres,
  type StartedValkey,
  appDatabase,
  exampleValue,
  rolePasswordKeys,
  startPostgres,
  startValkey,
} from "@bricx/db-bootstrap/stack";
import { migrate } from "@bricx/db/migrate";
import type { StartedTestContainer } from "testcontainers";

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

export { composeValkeyCommand } from "@bricx/db-bootstrap/stack";

export async function startStack(): Promise<Stack> {
  const [postgres, valkey]: [BootstrappedPostgres, StartedValkey] =
    await Promise.all([startPostgres(), startValkey()]);
  const url = (role: Role) =>
    `postgres://${role}:${exampleValue(rolePasswordKeys[role])}@${postgres.container.getHost()}:${String(postgres.container.getMappedPort(5432))}/${appDatabase}`;
  await migrate({ reveal: () => url("bricx_owner") });
  return {
    postgres,
    valkey: valkey.container,
    url,
    valkeyUrl: () => valkey.url(),
    async stop() {
      await Promise.all([postgres.container.stop(), valkey.stop()]);
    },
  };
}
