// Builds the API: Fastify adapter (body cap, correlation id), Helmet, CORS
// allow-list, /v1 URI versioning, pino logs. bootstrap.ts listens; tests
// call createApp() and inject requests.
import type { IncomingMessage } from "node:http";
import type { Writable } from "node:stream";
import type { ApiConfig } from "@bricx/config/api";
import { type Database, openDatabase } from "@bricx/db/database";
import helmet from "@fastify/helmet";
import { type Provider, type Type, VersioningType } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module.js";
import { systemClock } from "./common/clock.js";
import { registerRequestContext } from "./common/db/context.hook.js";
import { createProbes, type Probes } from "./common/health/probes.js";
import { createLogger } from "./common/logging.js";
import { REQUEST_ID_HEADER, requestIdGenerator } from "./common/request-id.js";
import {
  buildOpenApiDocument,
  serializeOpenApiDocument,
} from "./openapi/document.js";
import { OpenApiDocumentHolder } from "./openapi/holder.js";

/**
 * Largest request body, in bytes (P4 plan D5; ADR 0047: the body must be
 * capped before validation). Uploads go to S3 directly (presigned), so API
 * bodies stay small; a route that needs more raises it for itself.
 */
export const BODY_LIMIT_BYTES = 1_048_576;

/**
 * The request pool (P4-03, ADR 0053). Postgres cancels a statement after
 * 30 s (statement_timeout, set in every withTx()); the client gives up 5 s
 * later, so the server's cancel normally comes first. (for architect review)
 */
export const REQUEST_POOL = {
  maxConnections: 10,
  timeoutMs: 2_000,
  statementTimeoutMs: 30_000,
  queryTimeoutMs: 35_000,
} as const;

export interface CreateAppOptions {
  /** Readiness probes; the real ones (createProbes) when absent. */
  readonly probes?: Probes;
  /** The request pool; one from config.database.url when absent. */
  readonly database?: Database;
  readonly logStream?: Writable;
  /** Test-only controllers and providers. */
  readonly extraControllers?: readonly Type[];
  readonly extraProviders?: readonly Provider[];
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
      database:
        options.database ?? openDatabase(config.database.url, REQUEST_POOL),
      logger,
      extraControllers: options.extraControllers,
      extraProviders: options.extraProviders,
    }),
    adapter,
    { bufferLogs: true },
  );
  app.useLogger(app.get(Logger));
  const fastify = app.getHttpAdapter().getInstance();
  // The API speaks JSON only (P4-07, ADR 0057): without Fastify's built-in
  // text/plain parser, any body that is not application/json is 415.
  fastify.removeContentTypeParser("text/plain");
  fastify.addHook("onRequest", (request, reply, done) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
    done();
  });
  registerRequestContext(app);
  await app.register(helmet);
  app.enableCors({ origin: [...config.http.corsOrigins] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
  // The OpenAPI document, once, after versioning (its paths carry /v1)
  // and before init (P4-08, ADR 0058): GET /openapi.json serves this text.
  app
    .get(OpenApiDocumentHolder)
    .set(serializeOpenApiDocument(buildOpenApiDocument(app)));
  return app;
}
