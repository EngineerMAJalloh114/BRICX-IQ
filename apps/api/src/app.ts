// Builds the API: Fastify adapter (body cap, correlation id), Helmet, CORS
// allow-list, /v1 URI versioning, pino logs. bootstrap.ts listens; tests
// call createApp() and inject requests.
import type { IncomingMessage } from "node:http";
import type { Writable } from "node:stream";
import { buildRegistry, defaultAdapters } from "@bricx/adapters/registry";
import type { AdapterDescriptor } from "@bricx/adapters/types";
import type { ApiConfig } from "@bricx/config/api";
import { fastifyTrustProxy } from "@bricx/config/rate-limits";
import { type Database, openDatabase } from "@bricx/db/database";
import {
  type DirectoryReader,
  type DirectoryWriter,
  openDirectoryReader,
  openDirectoryWriter,
} from "@bricx/db/directory";
import helmet from "@fastify/helmet";
import { type Provider, type Type, VersioningType } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { ThrottlerStorage } from "@nestjs/throttler";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module.js";
import type { UserinfoClient } from "./modules/invitations/public-api.js";
import type { GrantsSource } from "./common/auth/grants-source.js";
import { assertEveryRouteMarked } from "./common/auth/route-markers.js";
import type { JwksOptions } from "./common/auth/token-verifier.js";
import type { OrgSessionPolicy } from "./common/auth/session-policy.js";
import type { RevocationStore } from "./common/auth/revocation-store.js";
import type { SessionTracker } from "./common/auth/session-tracker.js";
import type { UserDirectory } from "./common/auth/user-directory.js";
import { type Clock, systemClock } from "./common/clock.js";
import { registerRequestContext } from "./common/db/context.hook.js";
import { createProbes, type Probes } from "./common/health/probes.js";
import { createLogger } from "./common/logging.js";
import { assertRateLimitClasses } from "./common/rate-limit/routes.js";
import { ValkeyRateLimitStore } from "./common/rate-limit/store.js";
import { openValkey } from "./common/valkey.js";
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
  /**
   * Test-only authentication overrides (P5-02, ADR 0062; never set by
   * bootstrap.ts, test/auth-routes.test.ts): the clock token times are
   * judged by, the JWKS settings, a user directory without a database, and
   * the grants source (production: DbGrantsSource, P5-05).
   */
  readonly clock?: Clock;
  readonly jwks?: Partial<JwksOptions>;
  readonly userDirectory?: UserDirectory;
  /** P5-03 (ADR 0063): a session tracker without a database, and an org session policy. */
  readonly sessionTracker?: SessionTracker;
  readonly sessionPolicy?: OrgSessionPolicy;
  /** P5-04 (ADR 0065): a revocation store without Valkey. */
  readonly revocationStore?: RevocationStore;
  readonly grantsSource?: GrantsSource;
  /**
   * P6-01 (ADR 0071): the directory_reader handle, used only when
   * config.directory is set; one from config.directory.url when absent.
   */
  readonly directoryReader?: DirectoryReader;
  /**
   * P6-02 (ADR 0072): the directory_writer handle, used only when
   * config.directoryWriter is set; one from its URL when absent.
   */
  readonly directoryWriter?: DirectoryWriter;
  /**
   * P6-04 (ADR 0074, owner condition C2): test-only adapters in place of
   * defaultAdapters(config.nodeEnv). No environment variable or config key
   * reaches this list; bootstrap.ts never sets it.
   */
  readonly adapters?: readonly AdapterDescriptor[];
  /**
   * P6-05d (ADR 0080): a test-only rate-limit store in place of Valkey
   * (the in-process store, or one that is always down). bootstrap.ts
   * never sets it.
   */
  readonly rateLimitStore?: ThrottlerStorage;
  /**
   * P6-06 (ADR 0077): a test-only userinfo client in place of the cell
   * Keycloak's (auth.userinfoUrl). bootstrap.ts never sets it.
   */
  readonly userinfo?: UserinfoClient;
}

/**
 * Fastify's own reading of a hop count, as a function (the adapter's
 * option type has no number): trust the nearest `hops` addresses.
 */
function trustProxyOption(
  value: false | number | string[],
): false | string[] | ((address: string, hop: number) => boolean) {
  if (typeof value !== "number") return value;
  return (_address, hop) => hop < value;
}

export async function createApp(
  config: ApiConfig,
  options: CreateAppOptions = {},
): Promise<NestFastifyApplication> {
  // P6-04 (ADR 0074, D11): the adapter registry first, from code, for the
  // validated config's environment; a broken one throws
  // AdapterRegistryError (a code and an index) before any pool opens.
  const adapterRegistry = buildRegistry(
    options.adapters ?? defaultAdapters(config.nodeEnv),
    { nodeEnv: config.nodeEnv },
  );
  const nextRequestId = requestIdGenerator(systemClock);
  const logger = createLogger(config, options.logStream);
  const adapter = new FastifyAdapter({
    loggerInstance: logger,
    bodyLimit: BODY_LIMIT_BYTES,
    // P6-05d (ADR 0080): request.ip honours X-Forwarded-For only from the
    // configured proxies (off unless TRUST_PROXY says otherwise).
    trustProxy: trustProxyOption(fastifyTrustProxy(config.trustProxy)),
    genReqId: (req: IncomingMessage) =>
      nextRequestId(req.headers[REQUEST_ID_HEADER]),
  });
  const database =
    options.database ?? openDatabase(config.database.url, REQUEST_POOL);
  // P6-05d (ADR 0080, owner condition C5): one lazy Valkey client for the
  // revocation store and the rate limiter; AppModule closes it.
  const valkey = openValkey(config.valkey.url);
  const clock = options.clock ?? systemClock;
  // P6-01 (ADR 0071): the directory_reader handle, only where the API
  // serves the global directory.
  const directoryReader =
    config.directory === undefined
      ? undefined
      : (options.directoryReader ?? openDirectoryReader(config.directory.url));
  // P6-02 (ADR 0072, D3): the directory_writer handle POST
  // /v1/organizations reserves slugs with; without it create is 503.
  const directoryWriter =
    config.directoryWriter === undefined
      ? undefined
      : (options.directoryWriter ??
        openDirectoryWriter(config.directoryWriter.url));
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot({
      probes: options.probes ?? createProbes(config),
      database,
      adapterRegistry,
      logger,
      auth: {
        auth: config.auth,
        database,
        valkey,
        clock,
        jwks: options.jwks,
        userDirectory: options.userDirectory,
        sessionTracker: options.sessionTracker,
        sessionPolicy: options.sessionPolicy,
        revocationStore: options.revocationStore,
        grantsSource: options.grantsSource,
      },
      rateLimit: {
        limits: config.rateLimits,
        store: options.rateLimitStore ?? new ValkeyRateLimitStore(valkey),
        clock,
      },
      openApiExposure: config.openApiExposure,
      devices: config.devices,
      accessGrants: config.accessGrants,
      directoryReader,
      organizations: {
        cellId: config.cellId,
        writer: directoryWriter,
        maxCreatedPerUser: config.organizations.maxCreatedPerUser,
      },
      invitations: {
        cellId: config.cellId,
        maxResends: config.invitations.maxResends,
        userinfoUrl: config.auth.userinfoUrl,
        userinfo: options.userinfo,
      },
      extraControllers: options.extraControllers,
      extraProviders: options.extraProviders,
    }),
    adapter,
    { bufferLogs: true },
  );
  // P5-07 (ADR 0068, condition 5): every route carries @Can, @NoPermission
  // or @Public, or the app does not start (test-only controllers too).
  // P6-05d (ADR 0080): every route's rate-limit class is a known one.
  try {
    assertEveryRouteMarked(app);
    assertRateLimitClasses(app);
  } catch (error) {
    await app.close();
    throw error;
  }
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
