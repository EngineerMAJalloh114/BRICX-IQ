// The OpenAPI 3.1 document (P4-08, ADR 0058, decision 2a): @nestjs/swagger
// scans the controllers and nestjs-zod DTOs (createDocument), nestjs-zod
// tidies its own schemas (cleanupOpenApiDoc), then this file post-processes
// what neither knows:
//   - a `default` application/problem+json ErrorEnvelope response on every
//     operation (ADR 0057), except ones marked x-bricx-plain-errors (the
//     health routes keep terminus's body and get a plain 503 instead);
//   - on x-bricx-idempotent operations, the required Idempotency-Key header
//     parameter and the Idempotent-Replayed response header;
//   - components.schemas.ErrorEnvelope from ErrorEnvelopeSchema's output
//     side (its input side is boundedObject's z.unknown(), which has no
//     JSON schema), and Money.amount's pattern ^-?\d+$ (owner condition 2:
//     AmountString is a z.string().check(), which emits no pattern);
//   - no `servers` (the client sets its base URL) and no `$schema` keys;
//   - P5-02 (ADR 0062): components.securitySchemes.bearer (an HTTP bearer
//     JWT) and `security: [{ bearer: [] }]` on every operation that is not
//     @Public() (x-bricx-public).
// The path and schema names are sorted; everything else keeps the order the
// decorators and schemas declare, so the document is byte-stable.
import { IDEMPOTENCY_KEY_PATTERN } from "@bricx/db/idempotency";
import { ErrorEnvelopeSchema } from "@bricx/validation/error-envelope";
import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { cleanupOpenApiDoc } from "nestjs-zod";
import { z } from "zod";
import { PUBLIC_EXTENSION } from "../common/auth/public.decorator.js";
import { HealthReport } from "../common/dto/health.dto.js";
import { Money } from "../common/dto/money.dto.js";
import { IDEMPOTENT_EXTENSION, PLAIN_ERRORS_EXTENSION } from "./extensions.js";

export { IDEMPOTENT_EXTENSION, PLAIN_ERRORS_EXTENSION };

export const OPENAPI_VERSION = "3.1.0";
export const PROBLEM_MEDIA_TYPE = "application/problem+json";
export const JSON_MEDIA_TYPE = "application/json";
export const IDEMPOTENCY_KEY_PARAMETER = "Idempotency-Key";
export const REPLAYED_RESPONSE_HEADER = "Idempotent-Replayed";
/**
 * Money.amount on the wire: an optionally negative run of digits. A
 * superset of @bricx/money's parser (no leading zeros, no -0, signed
 * 64-bit range), which every boundary still applies: the pattern tells a
 * client the field is never a JSON number.
 */
export const MONEY_AMOUNT_PATTERN = "^-?\\d+$";
const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

const ERROR_ENVELOPE_REF = "#/components/schemas/ErrorEnvelope";
const HEALTH_REPORT_REF = "#/components/schemas/HealthReport";

/** A JSON object as the document holds it; nothing here is typed by name. */
export type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isArray = (value: unknown): value is unknown[] => Array.isArray(value);

const objectAt = (parent: JsonObject, key: string): JsonObject => {
  const existing = parent[key];
  if (isObject(existing)) return existing;
  const created: JsonObject = {};
  parent[key] = created;
  return created;
};

/** Removes every `$schema` key (z.toJSONSchema adds one at its root). */
function stripSchemaKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSchemaKeys);
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (key !== "$schema") out[key] = stripSchemaKeys(item);
  }
  return out;
}

/** The object with its own keys sorted (one level: names of paths, of schemas). */
function sortedEntries(value: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const key of Object.keys(value).sort()) out[key] = value[key];
  return out;
}

function errorEnvelopeSchema(): JsonObject {
  const schema = stripSchemaKeys(
    z.toJSONSchema(ErrorEnvelopeSchema, { io: "output" }),
  );
  if (!isObject(schema))
    throw new Error("ErrorEnvelope schema is not an object");
  return schema;
}

function addMoneyPattern(schemas: JsonObject): void {
  const money = objectAt(schemas, "Money");
  const amount = objectAt(objectAt(money, "properties"), "amount");
  if (amount.type !== "string") {
    throw new Error("Money.amount is not a string in the generated schema");
  }
  amount.pattern = MONEY_AMOUNT_PATTERN;
}

const PROBLEM_RESPONSE: JsonObject = {
  description:
    "Any error: an RFC 9457 problem body in the ADR 0047 envelope (status, code, key, traceId, issues).",
  content: { [PROBLEM_MEDIA_TYPE]: { schema: { $ref: ERROR_ENVELOPE_REF } } },
};

const PLAIN_503_RESPONSE: JsonObject = {
  description: "A dependency is down: the same report with status error.",
  content: { [JSON_MEDIA_TYPE]: { schema: { $ref: HEALTH_REPORT_REF } } },
};

const IDEMPOTENCY_KEY_PARAM: JsonObject = {
  name: IDEMPOTENCY_KEY_PARAMETER,
  in: "header",
  required: true,
  description:
    "A key unique to this request from this user (a UUID): the same key replays the first answer for 24 h; the same key with a different body is 422 idempotency.key_reused.",
  schema: {
    type: "string",
    pattern: IDEMPOTENCY_KEY_PATTERN.source,
    minLength: 1,
    maxLength: IDEMPOTENCY_KEY_MAX_LENGTH,
  },
};

/** The bearer scheme every non-public operation requires (P5-02). */
export const BEARER_SCHEME = "bearer";
const BEARER_SECURITY_SCHEME: JsonObject = {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
};

const REPLAYED_HEADER: JsonObject = {
  description:
    'Present, "true", when this answer is the replay of an earlier request under the same Idempotency-Key; absent on the first answer.',
  schema: { type: "string", enum: ["true"] },
};

const FIRST_KEYS: ReadonlySet<string> = new Set([
  "openapi",
  "info",
  "paths",
  "components",
]);
const METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

function postProcessOperation(operation: JsonObject): void {
  if (operation[PUBLIC_EXTENSION] !== true) {
    operation.security = [{ [BEARER_SCHEME]: [] }];
  }
  const responses = objectAt(operation, "responses");
  if (operation[PLAIN_ERRORS_EXTENSION] === true) {
    responses["503"] ??= PLAIN_503_RESPONSE;
  } else {
    responses.default = PROBLEM_RESPONSE;
  }
  if (operation[IDEMPOTENT_EXTENSION] === true) {
    const parameters = isArray(operation.parameters)
      ? operation.parameters
      : [];
    operation.parameters = [
      ...parameters.filter(
        (p) => !(isObject(p) && p.name === IDEMPOTENCY_KEY_PARAMETER),
      ),
      IDEMPOTENCY_KEY_PARAM,
    ];
    for (const [status, response] of Object.entries(responses)) {
      if (!/^2\d\d$/.test(status) || !isObject(response)) continue;
      objectAt(response, "headers")[REPLAYED_RESPONSE_HEADER] = REPLAYED_HEADER;
    }
  }
}

/** The document, post-processed, as a plain JSON object with stable key order. */
export function buildOpenApiDocument(app: INestApplication): JsonObject {
  const config = new DocumentBuilder()
    .setOpenAPIVersion(OPENAPI_VERSION)
    .setTitle("BRICX IQ API")
    .setDescription(
      "Construction management: offline-first, multi-currency (money is minor units as strings), fully audited. Errors are application/problem+json in the ADR 0047 envelope.",
    )
    .setVersion("1")
    .build();
  const scanned = SwaggerModule.createDocument(app, config, {
    extraModels: [Money, HealthReport],
    operationIdFactory: (controllerKey, methodKey) =>
      `${controllerKey}_${methodKey}`,
  });
  const cleaned = cleanupOpenApiDoc(scanned, { version: "3.1" });
  const doc = stripSchemaKeys(JSON.parse(JSON.stringify(cleaned)));
  if (!isObject(doc)) throw new Error("the OpenAPI document is not an object");
  delete doc.servers;
  const components = objectAt(doc, "components");
  const schemas = objectAt(components, "schemas");
  schemas.ErrorEnvelope = errorEnvelopeSchema();
  addMoneyPattern(schemas);
  components.securitySchemes = { [BEARER_SCHEME]: BEARER_SECURITY_SCHEME };
  const paths = objectAt(doc, "paths");
  for (const item of Object.values(paths)) {
    if (!isObject(item)) continue;
    for (const method of METHODS) {
      const operation = item[method];
      if (isObject(operation)) postProcessOperation(operation);
    }
  }
  const rest: JsonObject = {};
  for (const [key, value] of Object.entries(doc)) {
    if (!FIRST_KEYS.has(key)) rest[key] = value;
  }
  return {
    openapi: doc.openapi,
    info: doc.info,
    paths: sortedEntries(paths),
    components: { ...components, schemas: sortedEntries(schemas) },
    ...rest,
  };
}

/** Pretty JSON with a trailing newline (what the committed file holds). */
export const serializeOpenApiDocument = (doc: JsonObject): string =>
  `${JSON.stringify(doc, null, 2)}\n`;
