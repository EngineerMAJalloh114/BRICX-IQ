// BoundaryPipe(schema): parses a body or query with @bricx/validation's
// parseAtBoundary() and throws ValidationError (422 validation_failed with
// the issues) on failure (P4-07, ADR 0057, decision 3a). P4-08 replaces it
// with nestjs-zod; the error path stays the same.
import { parseAtBoundary } from "@bricx/validation/error-envelope";
import { Injectable, type PipeTransform } from "@nestjs/common";
import type { z } from "zod";
import { ValidationError } from "./api-error.js";

@Injectable()
export class BoundaryPipe<T extends z.ZodType> implements PipeTransform<
  unknown,
  z.output<T>
> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const result = parseAtBoundary(this.schema, value);
    if (!result.success) throw new ValidationError(result.envelope);
    return result.data;
  }
}
