// The global validation pipe (P4-08, ADR 0058, decision 5a; replaces
// P4-07's BoundaryPipe). A parameter typed with a nestjs-zod DTO is parsed
// with @bricx/validation's parseAtBoundary(): bounded, with the ADR 0047
// issue codes (required, unknown_field with an empty path, never a
// client value), and a failure is ValidationError (422 validation_failed).
// A parameter without a DTO is passed through, as before. nestjs-zod's
// own createZodValidationPipe() calls schema.parse() with zod's default
// messages, which the envelope cannot map, so the pipe is ours.
import { parseAtBoundary } from "@bricx/validation/error-envelope";
import {
  type ArgumentMetadata,
  Injectable,
  type PipeTransform,
} from "@nestjs/common";
import { isZodDto } from "nestjs-zod/dto";
import type { z } from "zod";
import { ValidationError } from "./api-error.js";

/** A zod 4 schema (nestjs-zod types a DTO's schema as anything with parse). */
const isSchema = (value: unknown): value is z.ZodType =>
  typeof value === "object" && value !== null && "_zod" in value;

@Injectable()
export class ZodValidationPipe implements PipeTransform<unknown, unknown> {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const { metatype } = metadata;
    if (!isZodDto(metatype) || !isSchema(metatype.schema)) return value;
    const result = parseAtBoundary(metatype.schema, value);
    if (!result.success) throw new ValidationError(result.envelope);
    return result.data;
  }
}
