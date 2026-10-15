// Structured JSON logs: one pino instance, used by Fastify for its request
// lines (reqId = the correlation id from x-request-id, on every route,
// 404s and 413s included) and by Nest through nestjs-pino (useExisting).
// Credentials are redacted wherever a header could be logged.
import type { Writable } from "node:stream";
import type { ApiConfig } from "@bricx/config/api";
import { type Logger, pino } from "pino";

export const REDACTED_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
];

export function createLogger(config: ApiConfig, stream?: Writable): Logger {
  const options = {
    level: config.logLevel,
    redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
  };
  return stream === undefined ? pino(options) : pino(options, stream);
}
