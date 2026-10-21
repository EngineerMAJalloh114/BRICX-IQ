// P4-07 (ADR 0057, decisions 2a and 3a): every error leaves the API as an
// RFC 9457 problem+json body in the ADR 0047 envelope { status, code, key,
// traceId?, issues?, truncated? }, with the correlation id as traceId and
// no message, SQL, host or input value. 5xx are logged with the stack,
// 4xx without it. The health routes keep terminus's own body (platforms
// read it). No containers: fake probes and a database that must not be
// reached.
import { Writable } from "node:stream";
import { loadApiConfig } from "@bricx/config/api";
import type { Database } from "@bricx/db/database";
import {
  DatabaseUnavailableError,
  TransactionCommitError,
} from "@bricx/db/database";
import { ErrorEnvelopeSchema } from "@bricx/validation/error-envelope";
import { EmailSchema } from "@bricx/validation/email";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createZodDto } from "nestjs-zod";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { BODY_LIMIT_BYTES, createApp } from "../src/app.js";
import { Public } from "../src/common/auth/public.decorator.js";
import { ApiError } from "../src/common/errors/api-error.js";
import { PROBLEM_CONTENT_TYPE } from "../src/common/errors/problem.filter.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";

const SECRET = "handler-secret-message-9c2e";
const HOST = "db-host-7f3a.internal";

const Contact = z.strictObject({ email: EmailSchema, name: z.string() });
/** A nestjs-zod DTO: the global ZodValidationPipe parses it (P4-08). */
class ContactDto extends createZodDto(Contact) {}

/** Test-only routes that fail in every mapped way. */
// Public (P5-02): these routes test the app, not authentication, so
// they take no token (test/auth*.test.ts cover the guard).
@Controller({ path: "boom", version: "1" })
@Public()
class BoomController {
  @Get("api")
  api() {
    throw new ApiError("request.conflict");
  }

  @Get("generic")
  generic() {
    throw new Error(`${SECRET} at ${HOST}`);
  }

  @Get("http")
  http() {
    throw new NotFoundException(SECRET);
  }

  @Get("teapot")
  teapot() {
    throw new HttpException(SECRET, 418);
  }

  @Get("db")
  db() {
    throw new DatabaseUnavailableError();
  }

  @Get("commit/:sqlstate")
  commit(@Param("sqlstate") sqlstate: string) {
    throw new TransactionCommitError(sqlstate);
  }

  @Get("driver")
  driver() {
    throw Object.assign(new Error(`connection to ${HOST} lost`), {
      code: "57P01",
    });
  }

  @Get("string")
  string() {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- the filter must survive a non-Error
    throw SECRET;
  }

  @Post("validate")
  @HttpCode(200)
  validate(@Body() body: ContactDto) {
    return body;
  }

  /** No DTO: the pipe leaves the body alone. */
  @Post("raw")
  @HttpCode(200)
  raw(@Body() body: Record<string, unknown>) {
    return { keys: Object.keys(body) };
  }

  @Get("ok")
  ok() {
    return { ok: true };
  }
}

const config = loadApiConfig(apiEnv());

/** A request pool that must never be reached in these tests. */
const noDatabase: Database = {
  ping: () => Promise.reject(new Error("no database in errors.test")),
  withTx: () => Promise.reject(new Error("no database in errors.test")),
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
    database: noDatabase,
    logStream,
    extraControllers: [BoomController],
  });
  await app.init();
  const logs = () =>
    lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { app, lines, logs };
}

/** The response is a valid envelope of `code` with `status`, as problem+json. */
function expectProblem(
  res: { statusCode: number; headers: Record<string, unknown>; body: string },
  status: number,
  code: string,
) {
  expect(res.statusCode).toBe(status);
  expect(String(res.headers["content-type"])).toMatch(
    /^application\/problem\+json(; charset=utf-8)?$/,
  );
  expect(PROBLEM_CONTENT_TYPE).toBe("application/problem+json");
  const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(res.body));
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error("not an envelope");
  expect(parsed.data.status).toBe(status);
  expect(parsed.data.code).toBe(code);
  expect(parsed.data.key).toBe(`errors:${code}`);
  expect(parsed.data.traceId).toBe(res.headers["x-request-id"]);
  expect(res.body).not.toContain(SECRET);
  expect(res.body).not.toContain(HOST);
  expect(res.body).not.toContain("message");
  expect(res.body).not.toContain("detail");
  expect(res.body).not.toContain("title");
  return parsed.data;
}

describe("the problem+json envelope", () => {
  test("an ApiError answers with its registered code and status, logged at info without a stack", async () => {
    const { app, logs } = await start();
    const res = await app.inject({
      method: "GET",
      url: "/v1/boom/api",
      headers: { "x-request-id": "trace-abc.1" },
    });
    expectProblem(res, 409, "request.conflict");
    expect(res.headers["x-request-id"]).toBe("trace-abc.1");
    const rejected = logs().filter((l) => l.msg === "request.rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      level: 30,
      reqId: "trace-abc.1",
      code: "request.conflict",
      status: 409,
    });
    expect(rejected[0]).not.toHaveProperty("err");
    expect(logs().filter((l) => l.msg === "request.failed")).toEqual([]);
  });

  test("an unknown Error is 500 generic: the body carries no message; the log carries the stack", async () => {
    const { app, lines, logs } = await start();
    const res = await app.inject({ method: "GET", url: "/v1/boom/generic" });
    expectProblem(res, 500, "generic");
    const failed = logs().filter((l) => l.msg === "request.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      level: 50,
      code: "generic",
      status: 500,
      reqId: res.headers["x-request-id"],
    });
    const err = failed[0]?.err as { message: string; stack: string };
    expect(err.message).toContain(SECRET);
    expect(err.stack).toContain("errors.test.ts");
    expect(lines.join("\n")).not.toContain("request.rejected");
  });

  test("a thrown non-Error is 500 generic too, and never reaches the body", async () => {
    const { app } = await start();
    expectProblem(
      await app.inject({ method: "GET", url: "/v1/boom/string" }),
      500,
      "generic",
    );
  });

  test.each([
    ["http", 404, "not_found"],
    ["teapot", 500, "generic"],
    ["db", 503, "server_unavailable"],
    ["commit/23505", 409, "request.conflict"],
    ["commit/40P01", 409, "request.conflict"],
    ["commit/23514", 500, "generic"],
    ["commit/57014", 503, "server_unavailable"],
    ["commit/nope", 503, "server_unavailable"],
    ["driver", 503, "server_unavailable"],
  ])("/v1/boom/%s → %i %s", async (path, status, code) => {
    const { app } = await start();
    expectProblem(
      await app.inject({ method: "GET", url: `/v1/boom/${path}` }),
      status,
      code,
    );
  });

  test("a COMMIT failure of another class 23 is logged at error with the SQLSTATE", async () => {
    const { app, logs } = await start();
    await app.inject({ method: "GET", url: "/v1/boom/commit/23514" });
    const failed = logs().filter((l) => l.msg === "request.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ level: 50, code: "generic" });
    expect(
      (failed[0]?.err as { sqlstate?: string; stack?: string }).sqlstate,
    ).toBe("23514");
    // P5-02 commit 1: a database error is logged by type and stack frames
    // (no message line), so the class name is in `type`.
    expect((failed[0]?.err as { type?: string }).type).toBe(
      "TransactionCommitError",
    );
    expect((failed[0]?.err as { stack?: string }).stack).toMatch(/^ {4}at /);
  });

  test("an unknown route is 404 not_found; an unknown method on a known route is 404 too (Fastify yields no 405: owner condition 4)", async () => {
    const { app } = await start();
    expectProblem(
      await app.inject({ method: "GET", url: "/v1/nowhere" }),
      404,
      "not_found",
    );
    expectProblem(
      await app.inject({ method: "PUT", url: "/v1/boom/ok" }),
      404,
      "not_found",
    );
    expectProblem(
      await app.inject({ method: "GET", url: "/v1/boom/validate" }),
      404,
      "not_found",
    );
  });

  test("Fastify's parser errors reach the filter: bad JSON 400, body over 1 MiB 413, text/plain 415", async () => {
    const { app } = await start();
    expectProblem(
      await app.inject({
        method: "POST",
        url: "/v1/boom/validate",
        headers: { "content-type": "application/json" },
        payload: `{"email": ${SECRET}`,
      }),
      400,
      "request.malformed",
    );
    expectProblem(
      await app.inject({
        method: "POST",
        url: "/v1/boom/validate",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ data: "x".repeat(BODY_LIMIT_BYTES) }),
      }),
      413,
      "request.body_too_large",
    );
    expectProblem(
      await app.inject({
        method: "POST",
        url: "/v1/boom/validate",
        headers: { "content-type": "text/plain" },
        payload: SECRET,
      }),
      415,
      "request.unsupported_media_type",
    );
  });

  test("ZodValidationPipe: 422 validation_failed with the schema's issues (codes, paths and keys only)", async () => {
    const { app } = await start();
    const res = await app.inject({
      method: "POST",
      url: "/v1/boom/validate",
      headers: { "content-type": "application/json" },
      payload: { email: SECRET, extra: HOST },
    });
    const envelope = expectProblem(res, 422, "validation_failed");
    expect(envelope.issues).toEqual([
      {
        path: ["email"],
        code: "invalid_email",
        key: "validation:invalid_email",
      },
      { path: ["name"], code: "required", key: "validation:required" },
      // Unknown keys are one issue on the object itself (ADR 0047: the
      // path never carries a client-supplied key).
      { path: [], code: "unknown_field", key: "validation:unknown_field" },
    ]);
    const ok = await app.inject({
      method: "POST",
      url: "/v1/boom/validate",
      headers: { "content-type": "application/json" },
      payload: { email: "A@Example.com", name: "n" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ email: "a@example.com", name: "n" });
  });

  test("ZodValidationPipe: a body parameter without a DTO is passed through unparsed", async () => {
    const { app } = await start();
    const res = await app.inject({
      method: "POST",
      url: "/v1/boom/raw",
      headers: { "content-type": "application/json" },
      payload: { email: SECRET, extra: HOST },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ keys: ["email", "extra"] });
  });

  test("a successful route is untouched: application/json and the handler's body", async () => {
    const { app } = await start();
    const res = await app.inject({ method: "GET", url: "/v1/boom/ok" });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toContain("application/json");
    expect(res.json()).toEqual({ ok: true });
  });

  test("the health routes keep terminus's body: /health/ready is 503 with { status, error } when a probe is down", async () => {
    const probes = fakeProbes();
    probes.db.down = true;
    const lines: string[] = [];
    app = await createApp(config, {
      probes,
      database: noDatabase,
      logStream: new Writable({
        write(chunk: Buffer, _encoding, done) {
          lines.push(chunk.toString("utf8"));
          done();
        },
      }),
    });
    await app.init();
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(String(res.headers["content-type"])).toContain("application/json");
    expect(res.json()).toMatchObject({
      status: "error",
      error: { db: { status: "down" } },
    });
  });
});
