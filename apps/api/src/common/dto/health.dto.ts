// The health report (P4-08, ADR 0058, decision 6a): terminus's
// HealthCheckResult as a nestjs-zod DTO, so /health/live and /health/ready
// are in the document with a typed 200 (and 503) body. The shape is
// terminus's own; this DTO only describes it.
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

const IndicatorResult = z.record(
  z.string(),
  z.looseObject({ status: z.string() }),
);

export const HealthReportSchema = z.strictObject({
  status: z.enum(["ok", "error", "shutting_down"]),
  info: IndicatorResult.optional(),
  error: IndicatorResult.optional(),
  details: IndicatorResult,
});

export class HealthReport extends createZodDto(HealthReportSchema) {}
