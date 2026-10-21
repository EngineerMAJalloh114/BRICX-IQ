// /health/live (the process answers; no dependency) and /health/ready
// (db, valkey and s3 answer). Not versioned: platforms probe fixed paths.
// A down dependency is reported as { status: "down" } and nothing else.
// Terminus's body stays (HealthExceptionFilter), not problem+json, so
// the operations are marked x-bricx-plain-errors in the document (P4-08,
// ADR 0058) and documented with the HealthReport DTO (terminus's own
// swagger decorators are off in its favour; the body is terminus's, so
// the DTO documents it and the response serializer is not applied).
// Public (P5-02, ADR 0062): platforms probe without a token.
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
import { ApiOkResponse } from "@nestjs/swagger";
import { PlainErrors } from "../../openapi/extensions.js";
import { Public } from "../auth/public.decorator.js";
import { HealthReport } from "../dto/health.dto.js";
import { HealthExceptionFilter } from "../errors/health.filter.js";
import { PROBES } from "./health.tokens.js";
import type { Probe, ProbeName, Probes } from "./probes.js";

@Controller({ path: "health", version: VERSION_NEUTRAL })
@UseFilters(HealthExceptionFilter)
@PlainErrors()
@Public()
export class HealthController {
  constructor(
    @Inject(HealthCheckService) private readonly health: HealthCheckService,
    @Inject(HealthIndicatorService)
    private readonly indicators: HealthIndicatorService,
    @Inject(PROBES) private readonly probes: Probes,
  ) {}

  @Get("live")
  @HealthCheck({ swaggerDocumentation: false })
  @ApiOkResponse({ type: HealthReport })
  live() {
    return this.health.check([]);
  }

  @Get("ready")
  @HealthCheck({ swaggerDocumentation: false })
  @ApiOkResponse({ type: HealthReport })
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
