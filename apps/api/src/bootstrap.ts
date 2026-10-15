// Starts the API: builds the app, closes it on SIGTERM/SIGINT (Nest's
// shutdown hooks: probes and pools close, in-flight requests finish), and
// listens on config.http.port. After the hooks the process exits 0 through
// process.exit: pino's stdout writes are asynchronous and flush on "exit",
// which Nest's default (re-raising the signal) skips, losing the last lines.
import type { ApiConfig } from "@bricx/config/api";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createApp } from "./app.js";

/**
 * Loopback outside production: a developer's API is not reachable from the
 * network. In production the container platform publishes the port.
 * (for architect review)
 */
export function listenHost(config: ApiConfig): string {
  return config.nodeEnv === "production" ? "0.0.0.0" : "127.0.0.1";
}

export async function bootstrap(
  config: ApiConfig,
): Promise<NestFastifyApplication> {
  const app = await createApp(config);
  app.enableShutdownHooks(["SIGTERM", "SIGINT"], { useProcessExit: true });
  await app.listen(config.http.port, listenHost(config));
  return app;
}
