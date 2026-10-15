// Builds the API: Fastify adapter (body cap, correlation id), Helmet, CORS
// allow-list, /v1 URI versioning, pino logs. bootstrap.ts listens; tests
// call createApp() and inject requests.
import type { IncomingMessage } from "node:http";
import type { Writable } from "node:stream";
import type { ApiConfig } from "@bricx/config/api";
import helmet from "@fastify/helmet";
import { type Type, VersioningType } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module.js";
import { systemClock } from "./common/clock.js";
import { createProbes, type Probes } from "./common/health/probes.js";
import { createLogger } from "./common/logging.js";
import { REQUEST_ID_HEADER, requestIdGenerator } from "./common/request-id.js";

/**
 * Largest request body, in bytes (P4 plan D5; ADR 0047: the body must be
 * capped before validation). Uploads go to S3 directly (presigned), so API
 * bodies stay small; a route that needs more raises it for itself.
 */
export const BODY_LIMIT_BYTES = 1_048_576;

export interface CreateAppOptions {
  /** Readiness probes; the real ones (createProbes) when absent. */
  readonly probes?: Probes;
  readonly logStream?: Writable;
  /** Test-only controllers. */
  readonly extraControllers?: readonly Type[];
}

export async function createApp(
  config: ApiConfig,
  options: CreateAppOptions = {},
): Promise<NestFastifyApplication> {
  const nextRequestId = requestIdGenerator(systemClock);
  const logger = createLogger(config, options.logStream);
  const adapter = new FastifyAdapter({
    loggerInstance: logger,
    bodyLimit: BODY_LIMIT_BYTES,
    genReqId: (req: IncomingMessage) =>
      nextRequestId(req.headers[REQUEST_ID_HEADER]),
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot({
      probes: options.probes ?? createProbes(config),
      logger,
      extraControllers: options.extraControllers,
    }),
    adapter,
    { bufferLogs: true },
  );
  app.useLogger(app.get(Logger));
  app
    .getHttpAdapter()
    .getInstance()
    .addHook("onRequest", (request, reply, done) => {
      void reply.header(REQUEST_ID_HEADER, request.id);
      done();
    });
  await app.register(helmet);
  app.enableCors({ origin: [...config.http.corsOrigins] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
  return app;
}
