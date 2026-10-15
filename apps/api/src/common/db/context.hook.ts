// Creates the request context for every request (P4-03, ADR 0053; owner
// change 1): a Fastify onRequest hook runs the rest of the request inside
// AsyncLocalStorage.run(store, done). A body sent in chunks over a real
// socket keeps the context (test/request-context.test.ts).
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { runWithRequestContext } from "./request-context.js";

export const DEVICE_ID_HEADER = "x-device-id";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** x-device-id when it is one canonical UUID (device ids are UUIDv7). */
export function deviceIdOf(header: string | string[] | undefined) {
  return typeof header === "string" && CANONICAL_UUID.test(header)
    ? header
    : undefined;
}

export function registerRequestContext(app: NestFastifyApplication): void {
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook("onRequest", (request, _reply, done) => {
    runWithRequestContext(
      {
        correlationId: request.id,
        ip: request.ip,
        deviceId: deviceIdOf(request.headers[DEVICE_ID_HEADER]),
      },
      done,
    );
  });
}
