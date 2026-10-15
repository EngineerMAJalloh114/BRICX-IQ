// API entry point. Config is validated first, before Nest or any app module
// is loaded (ADR 0039): a bad environment stops boot here with key names and
// codes only. This file never reads environment files: the dev script hands
// one to node, and production gets its environment from the platform.
import { ConfigError, loadApiConfig } from "@bricx/config/api";

let config;
try {
  config = loadApiConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

const { bootstrap } = await import("./bootstrap.js");
await bootstrap(config);
