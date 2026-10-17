// The API's request pool (P4-03, ADR 0053; owner change 2: the readiness
// probe keeps its own small pool). Global, so feature modules inject
// TxRunner without importing this module. Closed on shutdown. P4-07 adds
// the idempotency interceptor, after the request-context one; P4-08 the
// nestjs-zod response serializer after both (innermost), so a handler's
// result is encoded to its wire form before the idempotency layer sends
// the stored text (ADR 0058, owner condition 1).
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
import { ZodSerializerInterceptor } from "nestjs-zod";
import { IdempotencyInterceptor } from "../idempotency/idempotency.interceptor.js";
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
        // In this order: the context is sealed before the idempotency
        // layer reads the identity (P4-07, ADR 0057).
        { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
        { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
      ],
      exports: [TxRunner],
    };
  }
}
