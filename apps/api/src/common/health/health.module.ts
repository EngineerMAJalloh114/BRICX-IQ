// Health endpoints and the probes they use. The probes are closed when the
// app shuts down (enableShutdownHooks in bootstrap.ts, or app.close()).
import {
  type DynamicModule,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { TerminusModule } from "@nestjs/terminus";
import { HealthController } from "./health.controller.js";
import { PROBES } from "./health.tokens.js";
import type { Probes } from "./probes.js";

class ProbeLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PROBES) private readonly probes: Probes) {}

  private readonly logger = new Logger("Health");

  async onApplicationShutdown() {
    await Promise.allSettled(Object.values(this.probes).map((p) => p.close()));
    this.logger.log("readiness probes closed");
  }
}

@Module({})
export class HealthModule {
  static forRoot(probes: Probes): DynamicModule {
    return {
      module: HealthModule,
      // Terminus logs failed checks; its default logger would bypass pino.
      imports: [TerminusModule.forRoot({ logger: false })],
      controllers: [HealthController],
      providers: [{ provide: PROBES, useValue: probes }, ProbeLifecycle],
    };
  }
}
