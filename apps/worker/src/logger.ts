// The worker's logger (P4-06; P5-02 commit 1, ADR 0062): JSON lines with
// service "worker", written synchronously by default so the last line
// survives process.exit. Errors go through @bricx/db/log's serializer: a
// database error is its SQLSTATE, constraint, table, column and stack
// frames, never a message, detail or query parameter that can quote a
// value.
import { errorSerializers } from "@bricx/db/log";
import {
  type DestinationStream,
  type LevelWithSilent,
  type Logger,
  pino,
} from "pino";

export function createWorkerLogger(
  level: LevelWithSilent,
  stream: DestinationStream = pino.destination({ fd: 1, sync: true }),
): Logger {
  return pino(
    { level, base: { service: "worker" }, serializers: errorSerializers },
    stream,
  );
}
