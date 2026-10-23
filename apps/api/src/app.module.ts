// The root module. Feature modules (apps/api/src/modules/*) are added here
// from P4-05 on (P4-05: audit; P4-06: outbox; from P4-09, pnpm new-module
// adds each copy of modules/_template at the markers below, ADR 0059); P4-01 has logging and health, P4-03 the
// request pool, TxRunner and the request-context interceptor, P4-07 the
// problem+json error filter, P4-08 the OpenAPI document, the global
// nestjs-zod validation pipe and the response serializer, P5-02 the
// global AuthGuard (AuthModule) and OPENAPI_EXPOSURE, P5-03 the devices and
// sessions modules, P5-05 the roles module.
import type { ApiConfig, OpenApiExposure } from "@bricx/config/api";
import type { Database } from "@bricx/db/database";
import {
  type DynamicModule,
  Module,
  type Provider,
  type Type,
} from "@nestjs/common";
import { APP_FILTER, APP_PIPE } from "@nestjs/core";
import { LoggerModule } from "nestjs-pino";
import type { Logger } from "pino";
import {
  AuthModule,
  type AuthModuleOptions,
} from "./common/auth/auth.module.js";
import { DatabaseModule } from "./common/db/database.module.js";
import { ProblemFilter } from "./common/errors/problem.filter.js";
import { ZodValidationPipe } from "./common/errors/zod.pipe.js";
import { HealthModule } from "./common/health/health.module.js";
import type { Probes } from "./common/health/probes.js";
import { AuditModule } from "./modules/audit/public-api.js";
import { AccessGrantsModule } from "./modules/access-grants/public-api.js";
import { DevicesModule } from "./modules/devices/public-api.js";
import { OutboxModule } from "./modules/outbox/public-api.js";
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
  /** The pino instance Fastify logs requests with (see logging.ts). */
  readonly logger: Logger;
  /** The AuthGuard's settings and, in tests only, its overrides. */
  readonly auth: AuthModuleOptions;
  /** Who may read GET /openapi.json (P5-02, ADR 0062). */
  readonly openApiExposure: OpenApiExposure;
  /** The per-user device cap (P5-03, ADR 0063). */
  readonly devices: ApiConfig["devices"];
  /** The per-user grant cap and the longest window (P5-06, ADR 0067). */
  readonly accessGrants: ApiConfig["accessGrants"];
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
        AuthModule.forRoot(options.auth),
        AuditModule,
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
        ...(options.extraProviders ?? []),
      ],
    };
  }
}
