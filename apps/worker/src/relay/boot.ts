// Boots the worker after its config is valid (P4-06, ADR 0056):
// 1. Valkey: connect, and refuse to start unless maxmemory-policy is
//    noeviction (condition 4): an evicting Valkey can drop queued jobs the
//    outbox already marked published.
// 2. Postgres as bricx_relay (RELAY_DATABASE_URL): reachable, and the role
//    is bricx_relay (withRelayTx() checks it on every batch too).
// 3. Keycloak (P5-04, owner condition 3): the bricx-worker service
//    account's token, refused without it (keycloak_unavailable).
// 4. Postgres as bricx_app (DATABASE_URL; P5-06, ADR 0067): the expiry
//    consumer's pool, org-scoped by withTx() on every statement; reachable
//    (app_database_unavailable otherwise).
// 5. Start the relay, the sessions.revoked consumer, the users.mfa_check
//    consumer (P5-05, ADR 0066) and the access_grants.expire consumer with
//    its 5-minute sweep (P5-06); SIGTERM/SIGINT stop them after the work
//    in flight, close the queues and connections, and exit 0.
// A boot failure logs worker.boot_failed with a code (never a driver
// message: those can carry hosts) and exits 1. Logs are written
// synchronously so the last line survives process.exit.
import type { WorkerConfig } from "@bricx/config/worker";
import {
  type Database,
  RelayRoleError,
  type RelayDatabase,
  openDatabase,
  openRelayDatabase,
} from "@bricx/db/database";
import { createUuidV7Generator } from "@bricx/ids/uuid-v7";
import type { Redis } from "ioredis";
import {
  SWEEP_EVERY_MS,
  createAccessConsumer,
  scheduleSweep,
} from "../access/consumer.js";
import { dueReader } from "../access/due.js";
import { createAccessExpirer } from "../access/expiry.js";
import { createWorkerLogger } from "../logger.js";
import { createMfaConsumer } from "../mfa/consumer.js";
import { mfaTruth } from "../mfa/truth.js";
import { createRevocationConsumer } from "../revocation/consumer.js";
import { createKeycloakSessionEnder } from "../revocation/keycloak.js";
import { createBullPublisher } from "./publisher.js";
import { RELAY_DEFAULTS, createRelay } from "./relay.js";
import { outboxStore } from "./store.js";
import { evictionPolicy, openConsumerValkey, openValkey } from "./valkey.js";

type BootCode =
  | "valkey_unavailable"
  | "valkey_eviction_policy"
  | "database_unavailable"
  | "app_database_unavailable"
  | "relay_role"
  | "keycloak_unavailable";

class BootError extends Error {
  readonly code: BootCode;

  constructor(code: BootCode) {
    super(`worker boot: ${code}`);
    this.code = code;
  }
}

async function step<T>(code: BootCode, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch {
    throw new BootError(code);
  }
}

export async function runWorker(config: WorkerConfig): Promise<void> {
  const logger = createWorkerLogger(config.logLevel);
  let valkey: Redis | undefined;
  let consumerValkey: Redis | undefined;
  let database: RelayDatabase | undefined;
  let appDatabase: Database | undefined;
  const closeAll = async () => {
    await database?.close();
    await appDatabase?.close();
    valkey?.disconnect();
    consumerValkey?.disconnect();
  };
  const keycloak = createKeycloakSessionEnder(config.keycloak);

  try {
    const client = openValkey(config.valkey.url, {
      commandTimeoutMs: RELAY_DEFAULTS.commandTimeoutMs,
    });
    valkey = client;
    await step("valkey_unavailable", () => client.connect());
    const policy = await step("valkey_unavailable", () =>
      evictionPolicy(client),
    );
    if (policy !== "noeviction") throw new BootError("valkey_eviction_policy");

    const relayDb = openRelayDatabase(config.relayDatabase.url);
    database = relayDb;
    await step("database_unavailable", () => relayDb.ping());
    try {
      await relayDb.withRelayTx(() => Promise.resolve());
    } catch (error) {
      throw new BootError(
        error instanceof RelayRoleError ? "relay_role" : "database_unavailable",
      );
    }

    await step("keycloak_unavailable", () => keycloak.ensureToken());

    const appDb = openDatabase(config.database.url);
    appDatabase = appDb;
    await step("app_database_unavailable", () => appDb.ping());
    consumerValkey = openConsumerValkey(config.valkey.url);
  } catch (error) {
    await closeAll();
    const code = error instanceof BootError ? error.code : "unexpected";
    logger.fatal({ code }, "worker.boot_failed");
    process.exit(1);
  }

  const publisher = createBullPublisher(valkey, {
    retentionSeconds: RELAY_DEFAULTS.jobRetentionSeconds,
  });
  const relay = createRelay({
    database,
    store: outboxStore,
    publisher,
    logger,
    deadLetterAfter: config.outbox.deadLetterAfter,
  });
  const client = valkey;
  const consumer = createRevocationConsumer({
    connection: consumerValkey,
    deps: {
      keys: {
        async set(key, ttlSeconds) {
          await client.set(key, "1", "EX", ttlSeconds);
        },
      },
      keycloak,
      logger,
      ttlSeconds: config.revocation.ttlSeconds,
    },
  });
  const mfa = createMfaConsumer({
    connection: consumerValkey,
    deps: { truth: mfaTruth(database), keycloak, logger },
  });
  const clock = { now: () => Date.now() };
  const access = createAccessConsumer({
    connection: consumerValkey,
    deps: {
      expirer: createAccessExpirer({
        database: appDatabase,
        clock,
        ids: createUuidV7Generator({ clock }),
      }),
      due: dueReader(database),
      logger,
    },
  });

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "worker.stopping");
    void (async () => {
      let code = 0;
      try {
        await relay.stop();
        await consumer.close();
        await mfa.close();
        await access.close();
        await publisher.close();
        await closeAll();
      } catch {
        code = 1;
      }
      logger.info({ exitCode: code }, "worker.stopped");
      process.exit(code);
    })();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  try {
    await scheduleSweep(publisher);
  } catch {
    // Valkey answered a moment ago; a failed upsert is a boot failure too.
    await relay.stop();
    await consumer.close();
    await mfa.close();
    await access.close();
    await publisher.close();
    await closeAll();
    logger.fatal({ code: "valkey_unavailable" }, "worker.boot_failed");
    process.exit(1);
  }
  relay.start();
  logger.info(
    {
      deadLetterAfter: config.outbox.deadLetterAfter,
      revocationTtlSeconds: config.revocation.ttlSeconds,
      accessSweepEveryMs: SWEEP_EVERY_MS,
    },
    "worker.started",
  );
}
