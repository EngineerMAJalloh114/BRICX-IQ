// The root module. Feature modules (apps/api/src/modules/*) are added here
// from P4-05 on; P4-01 has logging and health only.
import { type DynamicModule, Module, type Type } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import type { Logger } from "pino";
import { HealthModule } from "./common/health/health.module.js";
import type { Probes } from "./common/health/probes.js";

export interface AppModuleOptions {
  readonly probes: Probes;
  /** The pino instance Fastify logs requests with (see logging.ts). */
  readonly logger: Logger;
  /** Test-only controllers (never set by bootstrap.ts). */
  readonly extraControllers?: readonly Type[] | undefined;
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
      ],
      controllers: [...(options.extraControllers ?? [])],
    };
  }
}
