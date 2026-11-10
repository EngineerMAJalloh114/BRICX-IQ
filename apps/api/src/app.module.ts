// The root module. Feature modules (apps/api/src/modules/*) are added here
// from P4-05 on (P4-05: audit; P4-06: outbox; from P4-09, pnpm new-module
// adds each copy of modules/_template at the markers below, ADR 0059); P4-01 has logging and health, P4-03 the
// request pool, TxRunner and the request-context interceptor, P4-07 the
// problem+json error filter, P4-08 the OpenAPI document, the global
// nestjs-zod validation pipe and the response serializer, P5-02 the
// global AuthGuard (AuthModule) and OPENAPI_EXPOSURE, P5-03 the devices and
// sessions modules, P5-05 the roles module, P6-01 the global directory
// (only where DIRECTORY_DATABASE_URL is set), P6-02 organisations, P6-03
// region configuration, P6-04 the adapter registry, P6-05 projects and
// sites, P6-05d the rate limiter (before AuthModule: its IP guard runs
// before the AuthGuard) and the shared Valkey client.
import type { AdapterRegistry } from "@bricx/adapters/registry";
import type { ApiConfig, OpenApiExposure } from "@bricx/config/api";
import type { Database } from "@bricx/db/database";
import type { DirectoryReader } from "@bricx/db/directory";
import {
  type DynamicModule,
  Module,
  type Provider,
  type Type,
} from "@nestjs/common";
import { APP_FILTER, APP_PIPE } from "@nestjs/core";
import { LoggerModule } from "nestjs-pino";
import type { Logger } from "pino";
import { AdaptersModule } from "./common/adapters/adapters.module.js";
import {
  AuthModule,
  type AuthModuleOptions,
} from "./common/auth/auth.module.js";
import { DatabaseModule } from "./common/db/database.module.js";
import { ProblemFilter } from "./common/errors/problem.filter.js";
import { ZodValidationPipe } from "./common/errors/zod.pipe.js";
import { HealthModule } from "./common/health/health.module.js";
import type { Probes } from "./common/health/probes.js";
import {
  RateLimitModule,
  type RateLimitModuleOptions,
} from "./common/rate-limit/rate-limit.module.js";
import { VALKEY_CLIENT, ValkeyConnection } from "./common/valkey.js";
import { AuditModule, DenialsModule } from "./modules/audit/public-api.js";
import { AccessGrantsModule } from "./modules/access-grants/public-api.js";
import { DevicesModule } from "./modules/devices/public-api.js";
import { DirectoryModule } from "./modules/directory/public-api.js";
import {
  OrganizationsModule,
  type OrganizationsModuleOptions,
} from "./modules/organizations/public-api.js";
import { OutboxModule } from "./modules/outbox/public-api.js";
import { ProjectsModule } from "./modules/projects/public-api.js";
import { RegionConfigModule } from "./modules/region-config/public-api.js";
import {
  InvitationsModule,
  type InvitationsModuleOptions,
} from "./modules/invitations/public-api.js";
import { MembershipsModule } from "./modules/memberships/public-api.js";
import { RolesModule } from "./modules/roles/public-api.js";
import { SessionsModule } from "./modules/sessions/public-api.js";
import { SodModule } from "./modules/sod/public-api.js";
import { OpenApiModule } from "./openapi/openapi.module.js";
// new-module: imports (pnpm new-module adds an import above, P4-09)

export interface AppModuleOptions {
  readonly probes: Probes;
  /** The request pool (withTx); the readiness probe has its own. */
  readonly database: Database;
  /** The adapter registry createApp() built and validated (P6-04, ADR 0074). */
  readonly adapterRegistry: AdapterRegistry;
  /** The pino instance Fastify logs requests with (see logging.ts). */
  readonly logger: Logger;
  /** The AuthGuard's settings and, in tests only, its overrides. */
  readonly auth: AuthModuleOptions;
  /** The limits, the store and the clock (P6-05d, ADR 0080). */
  readonly rateLimit: RateLimitModuleOptions;
  /** Who may read GET /openapi.json (P5-02, ADR 0062). */
  readonly openApiExposure: OpenApiExposure;
  /** The per-user device cap (P5-03, ADR 0063). */
  readonly devices: ApiConfig["devices"];
  /** The per-user grant cap and the longest window (P5-06, ADR 0067). */
  readonly accessGrants: ApiConfig["accessGrants"];
  /**
   * The directory_reader handle (P6-01, ADR 0071): set only where the API
   * serves the global directory (DIRECTORY_DATABASE_URL).
   */
  readonly directoryReader?: DirectoryReader | undefined;
  /** This cell's id, the directory writer and the create cap (P6-02, ADR 0072). */
  readonly organizations: OrganizationsModuleOptions;
  /** The cell id, the resend cap and the userinfo endpoint (P6-06, ADR 0077). */
  readonly invitations: InvitationsModuleOptions;
  /** Test-only controllers (never set by bootstrap.ts). */
  readonly extraControllers?: readonly Type[] | undefined;
  /** Test-only providers (never set by bootstrap.ts). */
  readonly extraProviders?: readonly Provider[] | undefined;
}

@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        // Fastify logs each request itself (every route, versioned or not:
        // nestjs-pino's middleware route is versioned once a controller
        // declares a version, and /health/* then went unlogged). Nest's own
        // logs go to the same pino instance.
        LoggerModule.forRoot({
          pinoHttp: { logger: options.logger },
          useExisting: true,
        }),
        HealthModule.forRoot(options.probes),
        DatabaseModule.forRoot(options.database),
        AdaptersModule.forRoot(options.adapterRegistry),
        // P6-05d (ADR 0080): before AuthModule (guard order).
        RateLimitModule.forRoot(options.rateLimit),
        AuthModule.forRoot(options.auth),
        AuditModule,
        // P6-06 (ADR 0077, D17, C8): refused authorisations, deduplicated
        // in the shared Valkey client.
        DenialsModule.forRoot(options.auth.valkey),
        OutboxModule,
        OpenApiModule.forRoot(options.openApiExposure),
        // P5-03 (ADR 0063): devices and sessions.
        SessionsModule,
        SodModule,
        DevicesModule.forRoot(options.devices),
        // P5-05 (ADR 0066): roles, then memberships.
        RolesModule,
        MembershipsModule,
        // P5-06 (ADR 0067): temporary elevations.
        AccessGrantsModule.forRoot(options.accessGrants),
        // P6-01 (ADR 0071): the public directory route, global deployment only.
        ...(options.directoryReader === undefined
          ? []
          : [DirectoryModule.forRoot({ reader: options.directoryReader })]),
        // P6-02 (ADR 0072): organisations.
        OrganizationsModule.forRoot(options.organizations),
        // P6-03 (ADR 0073): region configuration.
        RegionConfigModule,
        // P6-05 (ADR 0075): projects and sites.
        ProjectsModule,
        // P6-06 (ADR 0077): invitations.
        InvitationsModule.forRoot(options.invitations),
        // new-module: modules (pnpm new-module adds a module above, P4-09)
      ],
      controllers: [...(options.extraControllers ?? [])],
      providers: [
        // Every error leaves as problem+json (P4-07, ADR 0057).
        { provide: APP_FILTER, useClass: ProblemFilter },
        // A nestjs-zod DTO parameter is parsed at the boundary (P4-08,
        // ADR 0058); the response serializer is registered with the
        // interceptors in DatabaseModule, where their order is fixed.
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        // The shared Valkey client (P6-05d), closed on shutdown.
        {
          provide: VALKEY_CLIENT,
          useValue: new ValkeyConnection(options.auth.valkey),
        },
        ...(options.extraProviders ?? []),
      ],
    };
  }
}
