// /health/live (the process answers; no dependency) and /health/ready
// (db, valkey and s3 answer). Not versioned: platforms probe fixed paths.
// A down dependency is reported as { status: "down" } and nothing else.
// Terminus's body stays (HealthExceptionFilter), not problem+json.
import {
  Controller,
  Get,
  Inject,
  UseFilters,
  VERSION_NEUTRAL,
} from "@nestjs/common";
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorService,
} from "@nestjs/terminus";
import { HealthExceptionFilter } from "../errors/health.filter.js";
import { PROBES } from "./health.tokens.js";
import type { Probe, ProbeName, Probes } from "./probes.js";

@Controller({ path: "health", version: VERSION_NEUTRAL })
@UseFilters(HealthExceptionFilter)
export class HealthController {
  constructor(
    @Inject(HealthCheckService) private readonly health: HealthCheckService,
    @Inject(HealthIndicatorService)
    private readonly indicators: HealthIndicatorService,
    @Inject(PROBES) private readonly probes: Probes,
  ) {}

  @Get("live")
  @HealthCheck()
  live() {
    return this.health.check([]);
  }

  @Get("ready")
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.indicate("db", this.probes.db),
      () => this.indicate("valkey", this.probes.valkey),
      () => this.indicate("s3", this.probes.s3),
    ]);
  }

  private async indicate(name: ProbeName, probe: Probe) {
    const session = this.indicators.check(name);
    try {
      await probe.check();
      return session.up();
    } catch {
      return session.down();
    }
  }
}
