// The wire form of a handler's result (P4-08, ADR 0058, owner condition
// 1). An @Idempotent() route stores its response as text and replays that
// text verbatim, so what is stored must be what the serializer sends: a
// Money is stored as { amount: "<minor units>", currency }, never as a
// bigint JSON.stringify would refuse. wireFormOf(handler) reads the
// handler's @ZodResponse() / @ZodSerializerDto() metadata (the same the
// ZodSerializerInterceptor reads) and returns the two directions:
//   wire(result)  = what the serializer will send (codec: encode; plain
//                   DTO or schema: parse; none: the value itself)
//   unwire(json)  = the handler-shaped value for a replay (codec: decode;
//                   otherwise the JSON itself), which the serializer then
//                   encodes again to the identical text.
// A handler without a DTO that returns a bigint fails at JSON.stringify:
// 500 generic, nothing stored (test/idempotency.int.test.ts).
import { isZodDto } from "nestjs-zod/dto";
import { z } from "zod";

/**
 * nestjs-zod's metadata key for ZodSerializerDto (ZodSerializerDtoOptions
 * is not exported): pinned by test/wire.test.ts.
 */
export const SERIALIZER_METADATA = "ZOD_SERIALIZER_DTO_OPTIONS";

export interface WireForm {
  readonly wire: (result: unknown) => unknown;
  readonly unwire: (json: unknown) => unknown;
}

const IDENTITY: WireForm = {
  wire: (result) => result,
  unwire: (json) => json,
};

/** A zod 4 schema (nestjs-zod types a DTO's schema as anything with parse). */
const isSchema = (value: unknown): value is z.ZodType =>
  typeof value === "object" && value !== null && "_zod" in value;

function formOf(target: unknown, array: boolean): WireForm {
  const dto = isZodDto(target) ? target : undefined;
  const base = dto === undefined ? target : dto.schema;
  if (!isSchema(base)) return IDENTITY;
  const schema = array ? base.array() : base;
  if (dto?.codec === true) {
    return {
      wire: (result) => z.encode(schema, result),
      unwire: (json) => z.decode(schema, json),
    };
  }
  return { wire: (result) => schema.parse(result), unwire: (json) => json };
}

export function wireFormOf(handler: object): WireForm {
  const options: unknown = Reflect.getMetadata(SERIALIZER_METADATA, handler);
  if (options === undefined) return IDENTITY;
  return Array.isArray(options)
    ? formOf(options[0], true)
    : formOf(options, false);
}
