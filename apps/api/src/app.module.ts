// The root module. Feature modules (apps/api/src/modules/*) are added here
// from P4-05 on (P4-05: audit; P4-06: outbox); P4-01 has logging and health, P4-03 the
// request pool, TxRunner and the request-context interceptor, P4-07 the
// problem+json error filter, P4-08 the OpenAPI document, the global
// nestjs-zod validation pipe and the response serializer.
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
import { DatabaseModule } from "./common/db/database.module.js";
import { ProblemFilter } from "./common/errors/problem.filter.js";
import { ZodValidationPipe } from "./common/errors/zod.pipe.js";
import { HealthModule } from "./common/health/health.module.js";
import type { Probes } from "./common/health/probes.js";
import { AuditModule } from "./modules/audit/public-api.js";
import { OutboxModule } from "./modules/outbox/public-api.js";
import { OpenApiModule } from "./openapi/openapi.module.js";

export interface AppModuleOptions {
  readonly probes: Probes;
  /** The request pool (withTx); the readiness probe has its own. */
  readonly database: Database;
  /** The pino instance Fastify logs requests with (see logging.ts). */
  readonly logger: Logger;
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
        AuditModule,
        OutboxModule,
        OpenApiModule,
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
