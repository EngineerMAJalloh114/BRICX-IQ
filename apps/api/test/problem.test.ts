// P4-07 (ADR 0057): problemFor(error) is the whole mapping table from a
// thrown value to an error-envelope code and a log level, as a pure
// function. Owner condition 3 pins the COMMIT failures; decision 3a the
// HttpException statuses; the rest is the fallback: 500 generic, logged
// with the stack, never with the message in the body.
import { ERROR_STATUS } from "@bricx/validation/codes";
import {
  DatabaseUnavailableError,
  NestedTransactionError,
  TransactionCommitError,
} from "@bricx/db/database";
import { IdempotencyError } from "@bricx/db/idempotency";
import { OutboxError } from "@bricx/db/outbox";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { describe, expect, test } from "vitest";
import {
  NoRequestContextError,
  NoTenantContextError,
} from "../src/common/db/request-context.js";
import { ApiError, ValidationError } from "../src/common/errors/api-error.js";
import { IdempotencyMisuseError } from "../src/common/idempotency/state.js";
import { problemFor } from "../src/common/errors/problem.js";

/** A node-postgres DatabaseError as a handler sees it (its shape only). */
const pgError = (code: string) =>
  Object.assign(new Error(`driver text naming host-7f3a and the query`), {
    code,
    severity: "ERROR",
  });

describe("problemFor(error)", () => {
  test("ApiError: its registered code, 4xx logged at info, 5xx at error", () => {
    expect(problemFor(new ApiError("request.conflict"))).toEqual({
      code: "request.conflict",
      log: "info",
    });
    expect(problemFor(new ApiError("idempotency.response_too_large"))).toEqual({
      code: "idempotency.response_too_large",
      log: "error",
    });
    expect(problemFor(new ApiError("forbidden"))).toEqual({
      code: "forbidden",
      log: "info",
    });
  });

  test("ValidationError: validation_failed with its issues and truncated flag", () => {
    const envelope = {
      status: 422,
      code: "validation_failed" as const,
      key: "errors:validation_failed" as const,
      issues: [
        {
          path: ["email"],
          code: "invalid_email" as const,
          key: "validation:invalid_email" as const,
        },
      ],
      truncated: true as const,
    };
    expect(problemFor(new ValidationError(envelope))).toEqual({
      code: "validation_failed",
      issues: envelope.issues,
      truncated: true,
      log: "info",
    });
  });

  test.each([
    [new BadRequestException("x"), "request.malformed"],
    [new UnauthorizedException("x"), "session_expired"],
    [new ForbiddenException("x"), "forbidden"],
    [new NotFoundException("x"), "not_found"],
    [new ConflictException("x"), "request.conflict"],
    [new PayloadTooLargeException("x"), "request.body_too_large"],
    [new UnsupportedMediaTypeException("x"), "request.unsupported_media_type"],
    [new UnprocessableEntityException("x"), "validation_failed"],
    [new HttpException("x", 429), "rate_limited"],
    [new HttpException("x", 502), "server_unavailable"],
    [new ServiceUnavailableException("x"), "server_unavailable"],
    [new HttpException("x", 504), "server_unavailable"],
    [new HttpException("x", 418), "generic"],
    [new HttpException("x", 501), "generic"],
  ] as const)("HttpException %s → %s", (error, code) => {
    expect(problemFor(error)).toEqual({
      code,
      log: ERROR_STATUS[code] >= 500 ? "error" : "info",
    });
  });

  test("Fastify's own errors (statusCode + code) map by status: bad JSON 400, body 413, media type 415", () => {
    const fastify = (statusCode: number, code: string) =>
      Object.assign(new Error("fastify text"), { statusCode, code });
    expect(problemFor(fastify(400, "FST_ERR_CTP_INVALID_JSON_BODY"))).toEqual({
      code: "request.malformed",
      log: "info",
    });
    expect(problemFor(fastify(413, "FST_ERR_CTP_BODY_TOO_LARGE"))).toEqual({
      code: "request.body_too_large",
      log: "info",
    });
    expect(problemFor(fastify(415, "FST_ERR_CTP_INVALID_MEDIA_TYPE"))).toEqual({
      code: "request.unsupported_media_type",
      log: "info",
    });
    expect(problemFor(fastify(500, "FST_ERR_SOMETHING"))).toEqual({
      code: "generic",
      log: "error",
    });
  });

  test("the request context: no tenant → 401 (pre-P5, owner condition 6); no context or nesting → 500", () => {
    expect(problemFor(new NoTenantContextError())).toEqual({
      code: "session_expired",
      log: "info",
    });
    expect(problemFor(new NoRequestContextError())).toEqual({
      code: "generic",
      log: "error",
    });
    expect(problemFor(new NestedTransactionError())).toEqual({
      code: "generic",
      log: "error",
    });
  });

  test("the database: unavailable → 503", () => {
    expect(problemFor(new DatabaseUnavailableError())).toEqual({
      code: "server_unavailable",
      log: "error",
    });
  });

  test.each([
    ["23505", "request.conflict", "info"],
    ["23503", "request.conflict", "info"],
    ["23P01", "request.conflict", "info"],
    ["40001", "request.conflict", "info"],
    ["40P01", "request.conflict", "info"],
    ["23514", "generic", "error"],
    ["23502", "generic", "error"],
    ["57014", "server_unavailable", "error"],
    ["57P01", "server_unavailable", "error"],
    ["08006", "server_unavailable", "error"],
    ["XX000", "server_unavailable", "error"],
    [undefined, "server_unavailable", "error"],
  ] as const)(
    "TransactionCommitError(%s) → %s (owner condition 3)",
    (sqlstate, code, log) => {
      expect(problemFor(new TransactionCommitError(sqlstate))).toEqual({
        code,
        log,
      });
    },
  );

  test.each([
    ["08006", "server_unavailable", "error"],
    ["57P01", "server_unavailable", "error"],
    ["53300", "server_unavailable", "error"],
    ["40001", "request.conflict", "info"],
    ["40P01", "request.conflict", "info"],
    ["23505", "generic", "error"],
    ["42501", "generic", "error"],
  ] as const)(
    "a driver error inside fn with SQLSTATE %s → %s (connection classes 08, 53, 57 are 503; 40001 and 40P01 retryable)",
    (sqlstate, code, log) => {
      expect(problemFor(pgError(sqlstate))).toEqual({ code, log });
    },
  );

  test("the driver's error arrives wrapped by Drizzle (its cause): the SQLSTATE is read through the chain", () => {
    const wrapped = (code: string) =>
      new Error("Failed query: INSERT ...", { cause: pgError(code) });
    expect(problemFor(wrapped("57P01"))).toEqual({
      code: "server_unavailable",
      log: "error",
    });
    expect(problemFor(wrapped("40001"))).toEqual({
      code: "request.conflict",
      log: "info",
    });
    expect(problemFor(wrapped("23505"))).toEqual({
      code: "generic",
      log: "error",
    });
  });

  test("a connection failure without a SQLSTATE (the socket, or a client whose connection ended) → 503", () => {
    for (const thrown of [
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      new Error("Connection terminated unexpectedly"),
      new Error(
        "Client has encountered a connection error and is not queryable",
      ),
      new Error("Failed query: SELECT 1", {
        cause: new Error("Connection terminated unexpectedly"),
      }),
    ]) {
      expect(problemFor(thrown)).toEqual({
        code: "server_unavailable",
        log: "error",
      });
    }
    expect(problemFor(new Error("Connection: nope"))).toEqual({
      code: "generic",
      log: "error",
    });
  });

  test("IdempotencyError: response_too_large has its own code; the rest is generic", () => {
    expect(problemFor(new IdempotencyError("response_too_large"))).toEqual({
      code: "idempotency.response_too_large",
      log: "error",
    });
    expect(problemFor(new IdempotencyError("invalid_key"))).toEqual({
      code: "generic",
      log: "error",
    });
    expect(problemFor(new IdempotencyMisuseError("second_run"))).toEqual({
      code: "generic",
      log: "error",
    });
  });

  test("anything else (an Error, an OutboxError, a string, undefined) → 500 generic, logged at error", () => {
    for (const thrown of [
      new Error("secret"),
      new OutboxError("invalid_payload"),
      "a string",
      undefined,
      null,
      42,
      { statusCode: 404 },
    ]) {
      expect(problemFor(thrown)).toEqual({ code: "generic", log: "error" });
    }
  });
});
