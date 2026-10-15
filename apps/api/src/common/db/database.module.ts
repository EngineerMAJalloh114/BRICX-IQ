// The API's request pool (P4-03, ADR 0053; owner change 2: the readiness
// probe keeps its own small pool). Global, so feature modules inject
// TxRunner without importing this module. Closed on shutdown.
import type { Database } from "@bricx/db/database";
import {
  type DynamicModule,
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { RequestContextInterceptor } from "./context.interceptor.js";
import { DATABASE } from "./database.tokens.js";
import { TxRunner } from "./tx-runner.js";

class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  private readonly logger = new Logger("Database");

  async onApplicationShutdown() {
    await this.database.close();
    this.logger.log("request pool closed");
  }
}

@Global()
@Module({})
export class DatabaseModule {
  static forRoot(database: Database): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        { provide: DATABASE, useValue: database },
        TxRunner,
        DatabaseLifecycle,
        { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
      ],
      exports: [TxRunner],
    };
  }
}
