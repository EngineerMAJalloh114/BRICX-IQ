// The health routes answer with terminus's own body ({ status, info,
// error, details }), which platforms read: Nest's base filter, not the
// problem+json one (P4-07, ADR 0057, decision 3a).
import { Catch } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";

@Catch()
export class HealthExceptionFilter extends BaseExceptionFilter {}
