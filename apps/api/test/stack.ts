// The dev stack's Postgres, Valkey and S3 for the integration tests,
// started from compose.yml's images: Postgres with the real init folder
// and the S3 bucket by the real s3-init one-shot (@bricx/db-bootstrap).
import {
  appDatabase,
  type BootstrappedPostgres,
  composeImage,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { startInit, startS3 } from "@bricx/db-bootstrap/s3";
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { apiEnv } from "./env.js";

export interface Stack {
  network: StartedNetwork;
  postgres: BootstrappedPostgres;
  valkey: StartedTestContainer;
  s3: StartedTestContainer;
  /** An API environment pointing at these containers. */
  env(overrides?: Record<string, string>): Record<string, string>;
  stop(): Promise<void>;
}

export async function startStack(): Promise<Stack> {
  const network = await new Network().start();
  const password = exampleValue("VALKEY_PASSWORD");
  const [postgres, valkey, s3] = await Promise.all([
    startPostgres(),
    new GenericContainer(composeImage("valkey"))
      .withCommand(["valkey-server", "--requirepass", password])
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
      .start(),
    startS3(network),
  ]);
  const init = await startInit(network);
  const run = await init.finish();
  if (run.exitCode !== 0) throw new Error(`s3-init failed: ${run.output}`);
  const host = postgres.container.getHost();
  return {
    network,
    postgres,
    valkey,
    s3,
    env: (overrides = {}) =>
      apiEnv({
        DATABASE_URL: `postgres://bricx_app:${exampleValue("BRICX_APP_PASSWORD")}@${host}:${String(postgres.container.getMappedPort(5432))}/${appDatabase}`,
        VALKEY_URL: `redis://default:${password}@${valkey.getHost()}:${String(valkey.getMappedPort(6379))}`,
        S3_ENDPOINT: `http://${s3.getHost()}:${String(s3.getMappedPort(8333))}`,
        ...overrides,
      }),
    async stop() {
      await Promise.all([postgres.container.stop(), valkey.stop(), s3.stop()]);
      await network.stop();
    },
  };
}
