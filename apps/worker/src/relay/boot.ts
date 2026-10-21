// Boots the worker after its config is valid (P4-06, ADR 0056):
// 1. Valkey: connect, and refuse to start unless maxmemory-policy is
//    noeviction (condition 4): an evicting Valkey can drop queued jobs the
//    outbox already marked published.
// 2. Postgres as bricx_relay (RELAY_DATABASE_URL): reachable, and the role
//    is bricx_relay (withRelayTx() checks it on every batch too).
// 3. Start the relay; SIGTERM/SIGINT stop it after the batch in flight,
//    close the queues and connections, and exit 0.
// A boot failure logs worker.boot_failed with a code (never a driver
// message: those can carry hosts) and exits 1. Logs are written
// synchronously so the last line survives process.exit.
import type { WorkerConfig } from "@bricx/config/worker";
import {
  RelayRoleError,
  type RelayDatabase,
  openRelayDatabase,
} from "@bricx/db/database";
import type { Redis } from "ioredis";
import { createWorkerLogger } from "../logger.js";
import { createBullPublisher } from "./publisher.js";
import { RELAY_DEFAULTS, createRelay } from "./relay.js";
import { outboxStore } from "./store.js";
import { evictionPolicy, openValkey } from "./valkey.js";

type BootCode =
  | "valkey_unavailable"
  | "valkey_eviction_policy"
  | "database_unavailable"
  | "relay_role";

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
  let database: RelayDatabase | undefined;
  const closeAll = async () => {
    await database?.close();
    valkey?.disconnect();
  };

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

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "worker.stopping");
    void (async () => {
      let code = 0;
      try {
        await relay.stop();
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

  relay.start();
  logger.info(
    { deadLetterAfter: config.outbox.deadLetterAfter },
    "worker.started",
  );
}
