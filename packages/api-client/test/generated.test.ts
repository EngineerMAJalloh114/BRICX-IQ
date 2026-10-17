// P4-08 (ADR 0058, decisions 7 and 8): the committed generated client
// matches the committed openapi.json: one exported function per
// operation, each sending its method and path through the mutator; the
// shared models are exported as types with Money.amount a string. Path
// parameters are passed and must appear in the URL (P4-09).
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, expectTypeOf, test } from "vitest";
import { configureApiClient, resetApiClient } from "../src/fetcher.ts";
import * as client from "../src/generated/client.ts";
import type {
  ErrorEnvelope,
  HealthReport,
  Money,
} from "../src/generated/client.ts";

interface Operation {
  method: string;
  path: string;
  operationId: string;
}

const document = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "../openapi.json"), "utf8"),
) as {
  openapi: string;
  paths: Record<string, Record<string, { operationId: string }>>;
};

const operations: Operation[] = Object.entries(document.paths).flatMap(
  ([route, item]) =>
    Object.entries(item).map(([method, op]) => ({
      method: method.toUpperCase(),
      path: route,
      operationId: op.operationId,
    })),
);

/** orval's function name for an operationId: HealthController_live -> healthControllerLive. */
const functionName = (operationId: string) =>
  operationId
    .replace(/[_-]+(\w)/g, (_, c: string) => c.toUpperCase())
    .replace(/^\w/, (c) => c.toLowerCase());

const urlOf = (input: string | URL | Request): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

afterEach(() => {
  resetApiClient();
});

describe("the generated client", () => {
  test("the committed document is OpenAPI 3.1 with the health routes", () => {
    expect(document.openapi).toBe("3.1.0");
    expect(operations.map((op) => `${op.method} ${op.path}`)).toEqual(
      expect.arrayContaining(["GET /health/live", "GET /health/ready"]),
    );
    expect(operations.length).toBeGreaterThanOrEqual(2);
  });

  test.each(operations)(
    "$method $path is exported as a function that sends that method to that path",
    async (op) => {
      const name = functionName(op.operationId);
      const fn = (client as Record<string, unknown>)[name];
      expect(fn, `${name} is exported`).toBeTypeOf("function");
      const calls: { url: string; method: string | undefined }[] = [];
      const fakeFetch: typeof fetch = (input, init) => {
        calls.push({ url: urlOf(input), method: init?.method });
        return Promise.resolve(
          new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      };
      configureApiClient({
        baseUrl: "https://api.example.test",
        fetch: fakeFetch,
      });
      // orval takes path parameters first, in path order (P4-09: a copied
      // module's GET /{id} is the first route with one).
      const params = [...op.path.matchAll(/\{(\w+)\}/g)].map(
        ([, param]) => `${String(param)}-value`,
      );
      const url = op.path.replace(/\{(\w+)\}/g, "$1-value");
      await (fn as (...args: string[]) => Promise<unknown>)(...params);
      expect(calls).toEqual([
        { url: `https://api.example.test${url}`, method: op.method },
      ]);
    },
  );

  test("models: Money.amount and currency are strings, ErrorEnvelope.code is the registry union, HealthReport.status the terminus statuses", () => {
    expectTypeOf<Money["amount"]>().toEqualTypeOf<string>();
    expectTypeOf<Money["currency"]>().toEqualTypeOf<string>();
    expectTypeOf<ErrorEnvelope["status"]>().toEqualTypeOf<number>();
    expectTypeOf<ErrorEnvelope["code"]>().toExtend<string>();
    expectTypeOf<"validation_failed">().toExtend<ErrorEnvelope["code"]>();
    expectTypeOf<"nope">().not.toExtend<ErrorEnvelope["code"]>();
    expectTypeOf<"ok">().toExtend<HealthReport["status"]>();
    const money: Money = { amount: "-1250", currency: "USD" };
    expect(money.amount).toBe("-1250");
  });
});
