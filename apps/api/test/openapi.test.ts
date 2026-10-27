// P4-08 (ADR 0058): the OpenAPI 3.1 document is built from the Nest
// metadata and nestjs-zod DTOs, then post-processed: every operation
// (the health routes apart) answers errors with a `default`
// application/problem+json ErrorEnvelope; every @Idempotent() operation
// documents the required Idempotency-Key header and the
// Idempotent-Replayed response header; Money's amount is a string
// matching ^-?\d+$ in request and response schemas (owner condition 2).
// GET /openapi.json serves the same bytes, built once. No containers.
import { Writable } from "node:stream";
import { loadApiConfig } from "@bricx/config/api";
import type { Database } from "@bricx/db/database";
import { IDEMPOTENCY_KEY_PATTERN } from "@bricx/db/idempotency";
import { fromMinor } from "@bricx/money/money";
import { ERROR_CODES } from "@bricx/validation/codes";
import { ErrorEnvelopeSchema } from "@bricx/validation/error-envelope";
import { Body, Controller, Get, Post } from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { ZodResponse, ZodSerializerDto, createZodDto } from "nestjs-zod";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { NoPermission } from "../src/common/auth/can.decorator.js";
import { createApp } from "../src/app.js";
import { Public } from "../src/common/auth/public.decorator.js";
import { Money } from "../src/common/dto/money.dto.js";
import {
  IDEMPOTENT_METADATA,
  Idempotent,
} from "../src/common/idempotency/decorator.js";
import {
  IDEMPOTENCY_KEY_PARAMETER,
  IDEMPOTENT_EXTENSION,
  MONEY_AMOUNT_PATTERN,
  PLAIN_ERRORS_EXTENSION,
  PROBLEM_MEDIA_TYPE,
  REPLAYED_RESPONSE_HEADER,
  buildOpenApiDocument,
  serializeOpenApiDocument,
} from "../src/openapi/document.js";
import { OPENAPI_PATH } from "../src/openapi/openapi.controller.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";
import { fixedRevocations } from "./support/auth.js";

const SECRET = "doc-secret-value-41c9";

/** A plain (non-codec) response DTO. */
class Report extends createZodDto(z.strictObject({ n: z.number() })) {}

/** Test-only routes: a DTO body, Money in and out, an @Idempotent() route. */
// Public (P5-02): these routes test the app, not authentication, so
// they take no token (test/auth*.test.ts cover the guard).
@NoPermission("test-only probe")
@Controller({ path: "doc", version: "1" })
@Public()
class DocController {
  @Post("money")
  @Idempotent()
  @ZodResponse({ status: 201, type: Money })
  create(@Body() body: Money) {
    return body;
  }

  @Get("money")
  @ZodResponse({ status: 200, type: Money })
  money() {
    return fromMinor(1250n, "USD");
  }

  // ZodResponse() types the handler's return and would reject these two at
  // compile time; ZodSerializerDto() is the runtime half it applies.
  @Get("bad-money")
  @ZodSerializerDto(Money)
  badMoney() {
    // Not a Money: the serializer must refuse it (500 generic).
    return { amount: 5, currency: SECRET };
  }

  @Get("bad-report")
  @ZodSerializerDto(Report)
  badReport() {
    return { n: SECRET };
  }

  @Get("plain")
  plain() {
    return { ok: true };
  }
}

const config = loadApiConfig(apiEnv());
const noDatabase: Database = {
  ping: () => Promise.reject(new Error("no database in openapi.test")),
  withTx: () => Promise.reject(new Error("no database in openapi.test")),
  close: () => Promise.resolve(),
};

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start() {
  const lines: string[] = [];
  const logStream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
      done();
    },
  });
  app = await createApp(config, {
    probes: fakeProbes(),
    revocationStore: fixedRevocations(),
    database: noDatabase,
    logStream,
    extraControllers: [DocController],
  });
  await app.init();
  const logs = () =>
    lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { app, logs };
}

type Json = Record<string, unknown>;
const asObject = (value: unknown): Json => {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  return value as Json;
};

/** Every operation object of the document: [path, method, operation]. */
function operations(doc: Json): [string, string, Json][] {
  const out: [string, string, Json][] = [];
  for (const [path, item] of Object.entries(asObject(doc.paths))) {
    for (const [method, operation] of Object.entries(asObject(item))) {
      out.push([path, method, asObject(operation)]);
    }
  }
  return out;
}

const operation = (doc: Json, path: string, method: string): Json => {
  const found = operations(doc).find(([p, m]) => p === path && m === method);
  if (found === undefined) throw new Error(`no ${method} ${path}`);
  return found[2];
};

const schemaOf = (doc: Json, name: string): Json =>
  asObject(asObject(asObject(doc.components).schemas)[name]);

/** Follows a $ref ("#/components/schemas/X") to its schema. */
function deref(doc: Json, schema: unknown): Json {
  const object = asObject(schema);
  const ref = object.$ref;
  if (typeof ref !== "string") return object;
  expect(ref).toMatch(/^#\/components\/schemas\/[A-Za-z]+$/);
  return schemaOf(doc, ref.slice("#/components/schemas/".length));
}

/** Every key, at any depth, with its value. */
function* entries(value: unknown, path = ""): Generator<[string, unknown]> {
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries())
      yield* entries(item, `${path}[${String(i)}]`);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      yield [`${path}/${key}`, item];
      yield* entries(item, `${path}/${key}`);
    }
  }
}

describe("the OpenAPI document", () => {
  test("is OpenAPI 3.1, has no servers, no $schema keys, and lists the real routes but not /openapi.json", async () => {
    const { app } = await start();
    const doc = asObject(buildOpenApiDocument(app));
    expect(doc.openapi).toBe("3.1.0");
    expect(doc).not.toHaveProperty("servers");
    expect(asObject(doc.info).title).toBe("BRICX IQ API");
    const paths = Object.keys(asObject(doc.paths));
    expect(paths).toContain("/health/live");
    expect(paths).toContain("/health/ready");
    expect(paths).toContain("/v1/doc/money");
    expect(paths).not.toContain(`/${OPENAPI_PATH}`);
    expect(paths.some((p) => p.includes("openapi"))).toBe(false);
    for (const [key] of entries(doc)) expect(key).not.toMatch(/\/\$schema$/);
    expect(JSON.stringify(doc)).not.toContain(SECRET);
  });

  test("builds the same bytes twice, and serializes as pretty JSON with a trailing newline", async () => {
    const { app } = await start();
    const a = serializeOpenApiDocument(buildOpenApiDocument(app));
    const b = serializeOpenApiDocument(buildOpenApiDocument(app));
    expect(a).toBe(b);
    expect(a.endsWith("}\n")).toBe(true);
    expect(a).toBe(`${JSON.stringify(JSON.parse(a), null, 2)}\n`);
  });

  test("Money: amount is a string with pattern ^-?\\d+$ in the request body and in the response (owner condition 2)", async () => {
    const { app } = await start();
    const doc = asObject(buildOpenApiDocument(app));
    expect(MONEY_AMOUNT_PATTERN).toBe("^-?\\d+$");
    const money = schemaOf(doc, "Money");
    expect(money).toEqual({
      type: "object",
      properties: {
        amount: { type: "string", pattern: "^-?\\d+$" },
        currency: { type: "string" },
      },
      required: ["amount", "currency"],
      additionalProperties: false,
    });
    const post = operation(doc, "/v1/doc/money", "post");
    const requestSchema = deref(
      doc,
      asObject(
        asObject(
          asObject(asObject(post.requestBody).content)["application/json"],
        ).schema,
      ),
    );
    expect(asObject(asObject(requestSchema.properties).amount)).toEqual({
      type: "string",
      pattern: "^-?\\d+$",
    });
    const responseSchema = deref(
      doc,
      asObject(
        asObject(
          asObject(asObject(asObject(post.responses)["201"]).content)[
            "application/json"
          ],
        ).schema,
      ),
    );
    expect(asObject(asObject(responseSchema.properties).amount)).toEqual({
      type: "string",
      pattern: "^-?\\d+$",
    });
    const get = operation(doc, "/v1/doc/money", "get");
    const getSchema = deref(
      doc,
      asObject(
        asObject(
          asObject(asObject(asObject(get.responses)["200"]).content)[
            "application/json"
          ],
        ).schema,
      ),
    );
    expect(asObject(asObject(getSchema.properties).amount).pattern).toBe(
      "^-?\\d+$",
    );
    // The pattern is a superset of the strict parser (no leading zeros, no
    // -0, 64-bit range): everything it rejects, the parser rejects too.
    const re = new RegExp("^-?\\d+$");
    for (const bad of ["1.5", "+1", " 1", "1e3", "", "-", "abc"]) {
      expect(re.test(bad)).toBe(false);
    }
    expect(re.test("-1250")).toBe(true);
  });

  test("ErrorEnvelope: the ADR 0047 envelope with every error code, and every operation but the health routes answers errors with a default problem+json response", async () => {
    const { app } = await start();
    const doc = asObject(buildOpenApiDocument(app));
    expect(PROBLEM_MEDIA_TYPE).toBe("application/problem+json");
    const envelope = schemaOf(doc, "ErrorEnvelope");
    expect(envelope.type).toBe("object");
    expect(envelope.required).toEqual(["status", "code", "key"]);
    expect(envelope.additionalProperties).toBe(false);
    const properties = asObject(envelope.properties);
    expect(Object.keys(properties)).toEqual([
      "status",
      "code",
      "key",
      "traceId",
      "issues",
      "truncated",
    ]);
    expect(asObject(properties.code)).toEqual({
      type: "string",
      enum: [...ERROR_CODES],
    });
    expect(asObject(properties.issues).type).toBe("array");
    expect(asObject(properties.truncated)).toEqual({
      type: "boolean",
      const: true,
    });
    // The schema accepts what the API sends.
    const sample = {
      status: 422,
      code: "validation_failed",
      key: "errors:validation_failed",
      issues: [],
    };
    expect(ErrorEnvelopeSchema.safeParse(sample).success).toBe(true);
    let problemOperations = 0;
    let plainOperations = 0;
    for (const [path, , op] of operations(doc)) {
      const responses = asObject(op.responses);
      if (path.startsWith("/health/")) {
        plainOperations += 1;
        expect(op[PLAIN_ERRORS_EXTENSION]).toBe(true);
        expect(responses).not.toHaveProperty("default");
        continue;
      }
      problemOperations += 1;
      expect(op).not.toHaveProperty(PLAIN_ERRORS_EXTENSION);
      const fallback = asObject(responses.default);
      expect(fallback.description).toBeTypeOf("string");
      expect(asObject(fallback.content)).toEqual({
        [PROBLEM_MEDIA_TYPE]: {
          schema: { $ref: "#/components/schemas/ErrorEnvelope" },
        },
      });
    }
    expect(plainOperations).toBe(2);
    expect(problemOperations).toBeGreaterThanOrEqual(4);
  });

  test("@Idempotent() operations require the Idempotency-Key header and document Idempotent-Replayed; others do neither (every @Idempotent() handler of the app)", async () => {
    const { app } = await start();
    const doc = asObject(buildOpenApiDocument(app));
    expect(IDEMPOTENCY_KEY_PARAMETER).toBe("Idempotency-Key");
    expect(REPLAYED_RESPONSE_HEADER).toBe("Idempotent-Replayed");
    const post = operation(doc, "/v1/doc/money", "post");
    expect(post[IDEMPOTENT_EXTENSION]).toBe(true);
    const parameters = (post.parameters as unknown[]).map(asObject);
    const key = parameters.filter((p) => p.name === IDEMPOTENCY_KEY_PARAMETER);
    expect(key).toHaveLength(1);
    expect(key[0]).toEqual({
      name: IDEMPOTENCY_KEY_PARAMETER,
      in: "header",
      required: true,
      description: expect.stringContaining("24") as unknown,
      schema: {
        type: "string",
        pattern: IDEMPOTENCY_KEY_PATTERN.source,
        minLength: 1,
        maxLength: 255,
      },
    });
    const created = asObject(asObject(post.responses)["201"]);
    expect(
      asObject(asObject(created.headers)[REPLAYED_RESPONSE_HEADER]),
    ).toEqual({
      description: expect.stringContaining("replay") as unknown,
      schema: { type: "string", enum: ["true"] },
    });
    // Every marked operation documents the header pair like the one above;
    // every other operation does neither. AppModule's own @Idempotent()
    // routes (a pnpm new-module copy's create, P4-09) count too, so the
    // marked operations are exactly the @Idempotent() handlers.
    let marked = 0;
    for (const [, , op] of operations(doc)) {
      const idempotent = op[IDEMPOTENT_EXTENSION] === true;
      if (idempotent) marked += 1;
      else expect(op).not.toHaveProperty(IDEMPOTENT_EXTENSION);
      const keys = ((op.parameters as unknown[] | undefined) ?? [])
        .map(asObject)
        .filter((p) => p.name === IDEMPOTENCY_KEY_PARAMETER);
      expect(keys).toEqual(idempotent ? [key[0]] : []);
      const replayed = Object.values(asObject(op.responses))
        .map(asObject)
        .filter((r) => asObject(r.headers ?? {})[REPLAYED_RESPONSE_HEADER]);
      expect(replayed.length > 0).toBe(idempotent);
    }
    const handlers = [...app.get(ModulesContainer).values()]
      .flatMap((module) => [...module.controllers.values()])
      .flatMap(({ metatype }) => {
        const proto: unknown =
          typeof metatype === "function" ? metatype.prototype : undefined;
        if (typeof proto !== "object" || proto === null) return [];
        return Object.getOwnPropertyNames(proto).map((name): unknown =>
          Reflect.get(proto, name),
        );
      })
      .filter(
        (handler): handler is object =>
          typeof handler === "function" &&
          Reflect.getMetadata(IDEMPOTENT_METADATA, handler) === true,
      );
    expect(handlers.length).toBeGreaterThanOrEqual(1);
    expect(marked).toBe(handlers.length);
  });

  test("the health routes answer with a HealthReport", async () => {
    const { app } = await start();
    const doc = asObject(buildOpenApiDocument(app));
    for (const path of ["/health/live", "/health/ready"]) {
      const ok = asObject(
        asObject(operation(doc, path, "get").responses)["200"],
      );
      const schema = deref(
        doc,
        asObject(asObject(asObject(ok.content)["application/json"]).schema),
      );
      expect(asObject(asObject(schema.properties).status)).toEqual({
        type: "string",
        enum: ["ok", "error", "shutting_down"],
      });
    }
    const report = schemaOf(doc, "HealthReport");
    expect(report.required).toEqual(["status", "details"]);
  });

  test("GET /openapi.json serves the document's bytes as application/json, built once; it is not under /v1", async () => {
    const { app } = await start();
    expect(OPENAPI_PATH).toBe("openapi.json");
    const expected = serializeOpenApiDocument(buildOpenApiDocument(app));
    const first = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(first.statusCode).toBe(200);
    expect(String(first.headers["content-type"])).toMatch(/^application\/json/);
    expect(first.body).toBe(expected);
    const second = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(second.body).toBe(first.body);
    expect(second.headers.etag).toBeTypeOf("string");
    expect(second.headers.etag).toBe(first.headers.etag);
    const versioned = await app.inject({
      method: "GET",
      url: "/v1/openapi.json",
    });
    expect(versioned.statusCode).toBe(404);
  });
});

describe("responses through the serializer", () => {
  test("a Money result leaves as its wire form: amount string, currency code", async () => {
    const { app } = await start();
    const res = await app.inject({ method: "GET", url: "/v1/doc/money" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"amount":"1250","currency":"USD"}');
  });

  test("a result that is not the declared shape is 500 generic: nothing of the value is sent, the failure is logged", async () => {
    const { app, logs } = await start();
    const res = await app.inject({ method: "GET", url: "/v1/doc/bad-money" });
    expect(res.statusCode).toBe(500);
    expect(String(res.headers["content-type"])).toContain(
      "application/problem+json",
    );
    const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(res.body));
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("not an envelope");
    expect(parsed.data.code).toBe("generic");
    expect(parsed.data.issues).toBeUndefined();
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain("amount");
    const failed = logs().find((line) => line.msg === "request.failed");
    expect(failed).toBeDefined();
    expect(failed?.code).toBe("generic");
    expect(JSON.stringify(failed)).not.toContain(SECRET);
  });

  test("a result a plain DTO rejects is 500 generic with the issue paths logged, never sent", async () => {
    const { app, logs } = await start();
    const res = await app.inject({ method: "GET", url: "/v1/doc/bad-report" });
    expect(res.statusCode).toBe(500);
    const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(res.body));
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("not an envelope");
    expect(parsed.data.code).toBe("generic");
    expect(parsed.data.issues).toBeUndefined();
    expect(res.body).not.toContain(SECRET);
    const failed = logs().find((line) => line.msg === "request.failed");
    expect(failed).toBeDefined();
    const serialization = asObject(failed?.serialization);
    expect(serialization.issues).toEqual([
      { path: ["n"], code: "invalid_type" },
    ]);
    expect(JSON.stringify(failed)).not.toContain(SECRET);
  });

  test("a route without a response DTO is untouched", async () => {
    const { app } = await start();
    const res = await app.inject({ method: "GET", url: "/v1/doc/plain" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe("the Money DTO", () => {
  test("is a codec DTO over MoneySchema: parse decodes to Money, the class is named Money", () => {
    expect(Money.name).toBe("Money");
    expect(Money.codec).toBe(true);
    expect(Money.isZodDto).toBe(true);
    const parsed = Money.schema.parse({ amount: "-5", currency: "EUR" });
    expect(parsed).toEqual(fromMinor(-5n, "EUR"));
    expect(z.encode(Money.schema, fromMinor(7n, "USD"))).toEqual({
      amount: "7",
      currency: "USD",
    });
  });
});
