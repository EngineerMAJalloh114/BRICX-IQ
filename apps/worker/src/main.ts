// Worker entry point (P4-06; ROADMAP Also: P2-03). Config is validated
// first, before BullMQ, Valkey or the database is loaded (ADR 0039): a bad
// environment stops boot here with key names and codes only. This file
// never reads environment files: the dev script hands one to node, and
// production gets its environment from the platform.
import { ConfigError, loadWorkerConfig } from "@bricx/config/worker";

let config;
try {
  config = loadWorkerConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

const { runWorker } = await import("./relay/boot.js");
await runWorker(config);
