// P4-08 (ADR 0058, decision 7): the fetch mutator every generated
// operation goes through. configureApiClient() sets the base URL, the
// fetch implementation and a headers provider; customFetch() joins the
// URL, sends JSON, forwards an Idempotency-Key, resolves orval's
// { data, status, headers } shape, and turns a non-2xx
// answer into an ApiProblem carrying the ErrorEnvelope re-parsed with
// ErrorEnvelopeSchema (or none when the body is not an envelope). Nothing
// of a response body reaches an error message.
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ApiClientNotConfiguredError,
  ApiProblem,
  type ApiResponse,
  configureApiClient,
  customFetch,
  resetApiClient,
} from "../src/fetcher.ts";

const SECRET = "response-secret-7d1e";

const urlOf = (input: string | URL | Request): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(answer: (call: Call) => Response | Promise<Response>): {
  calls: Call[];
  fetch: typeof fetch;
} {
  const calls: Call[] = [];
  const impl: typeof fetch = (input, init) => {
    const call = { url: urlOf(input), init: init ?? {} };
    calls.push(call);
    return Promise.resolve(answer(call));
  };
  return { calls, fetch: impl };
}

const json = (status: number, body: unknown, type = "application/json") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": type },
  });

afterEach(() => {
  resetApiClient();
});

describe("configureApiClient + customFetch", () => {
  test("before configuration every call fails with ApiClientNotConfiguredError and sends nothing", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    try {
      await expect(
        customFetch("/health/live", { method: "GET" }),
      ).rejects.toBeInstanceOf(ApiClientNotConfiguredError);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("joins the base URL and the path (one slash), sends accept + content-type JSON, and parses the JSON body", async () => {
    const { calls, fetch } = fakeFetch(() => json(200, { status: "ok" }));
    configureApiClient({ baseUrl: "https://api.example.test/", fetch });
    const result = await customFetch<ApiResponse<{ status: string }>>(
      "/health/live",
      {
        method: "GET",
      },
    );
    expect(result.data).toEqual({ status: "ok" });
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("application/json");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.example.test/health/live");
    expect(calls[0]?.init.method).toBe("GET");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBeNull();
    configureApiClient({ baseUrl: "https://api.example.test", fetch });
    await customFetch("/health/live", { method: "GET" });
    expect(calls[1]?.url).toBe("https://api.example.test/health/live");
  });

  test("a body is sent as JSON text with content-type application/json; the Idempotency-Key header passes through", async () => {
    const { calls, fetch } = fakeFetch(() =>
      json(201, { amount: "10", currency: "USD" }),
    );
    configureApiClient({ baseUrl: "https://api.example.test", fetch });
    const result = await customFetch<ApiResponse<unknown>>("/v1/things", {
      method: "POST",
      headers: { "Idempotency-Key": "key-1" },
      body: JSON.stringify({ amount: "5", currency: "USD" }),
    });
    expect(result.data).toEqual({ amount: "10", currency: "USD" });
    expect(result.status).toBe(201);
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("idempotency-key")).toBe("key-1");
    expect(calls[0]?.init.body).toBe('{"amount":"5","currency":"USD"}');
  });

  test("the headers provider runs per request (a token that changes) and is merged under the call's own headers", async () => {
    let token = "t1";
    const { calls, fetch } = fakeFetch(() => json(200, {}));
    configureApiClient({
      baseUrl: "https://api.example.test",
      fetch,
      headers: () =>
        Promise.resolve({
          authorization: `Bearer ${token}`,
          "x-a": "provider",
        }),
    });
    await customFetch("/a", { method: "GET" });
    token = "t2";
    await customFetch("/a", { method: "GET", headers: { "x-a": "call" } });
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(
      "Bearer t1",
    );
    expect(new Headers(calls[1]?.init.headers).get("authorization")).toBe(
      "Bearer t2",
    );
    expect(new Headers(calls[0]?.init.headers).get("x-a")).toBe("provider");
    expect(new Headers(calls[1]?.init.headers).get("x-a")).toBe("call");
  });

  test("204 and an empty body resolve to data undefined", async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 204 }));
    configureApiClient({ baseUrl: "https://api.example.test", fetch });
    const result = await customFetch<ApiResponse<unknown>>("/a", {
      method: "DELETE",
    });
    expect(result.data).toBeUndefined();
    expect(result.status).toBe(204);
    const empty = fakeFetch(() => new Response("", { status: 200 }));
    configureApiClient({
      baseUrl: "https://api.example.test",
      fetch: empty.fetch,
    });
    const second = await customFetch<ApiResponse<unknown>>("/a", {
      method: "GET",
    });
    expect(second.data).toBeUndefined();
  });

  test("a non-2xx problem+json answer is an ApiProblem with the re-parsed envelope; the message carries the status and code only", async () => {
    const envelope = {
      status: 422,
      code: "validation_failed",
      key: "errors:validation_failed",
      traceId: "req-1",
      issues: [
        {
          path: ["amount"],
          code: "money.invalid_amount",
          key: "errors:money.invalid_amount",
        },
      ],
    };
    const { fetch } = fakeFetch(() =>
      json(422, envelope, "application/problem+json"),
    );
    configureApiClient({ baseUrl: "https://api.example.test", fetch });
    const error = await customFetch("/a", { method: "POST", body: "{}" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiProblem);
    if (!(error instanceof ApiProblem)) throw new Error("not an ApiProblem");
    expect(error.status).toBe(422);
    expect(error.envelope).toEqual(envelope);
    expect(error.code).toBe("validation_failed");
    expect(error.traceId).toBe("req-1");
    expect(error.message).toBe("api problem: 422 validation_failed");
    expect(error.name).toBe("ApiProblem");
  });

  test("a non-2xx answer that is not an envelope (a proxy's HTML, a malformed body) is an ApiProblem without one; nothing of the body is in the error", async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response(`<html>${SECRET}</html>`, {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
    );
    configureApiClient({ baseUrl: "https://api.example.test", fetch });
    const error = await customFetch("/a", { method: "GET" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiProblem);
    if (!(error instanceof ApiProblem)) throw new Error("not an ApiProblem");
    expect(error.status).toBe(502);
    expect(error.envelope).toBeUndefined();
    expect(error.code).toBeUndefined();
    expect(error.message).toBe("api problem: 502");
    expect(JSON.stringify(error)).not.toContain(SECRET);
    // An envelope-shaped body with a wrong key is not an envelope either.
    const bad = fakeFetch(() =>
      json(
        500,
        { status: 500, code: "generic", key: `errors:${SECRET}` },
        "application/problem+json",
      ),
    );
    configureApiClient({
      baseUrl: "https://api.example.test",
      fetch: bad.fetch,
    });
    const second = await customFetch("/a", { method: "GET" }).catch(
      (e: unknown) => e,
    );
    if (!(second instanceof ApiProblem)) throw new Error("not an ApiProblem");
    expect(second.envelope).toBeUndefined();
    expect(JSON.stringify(second)).not.toContain(SECRET);
  });

  test("a 2xx answer whose body is not JSON rejects with a SyntaxError (the caller's schema never sees it)", async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    configureApiClient({ baseUrl: "https://api.example.test", fetch });
    await expect(customFetch("/a", { method: "GET" })).rejects.toBeInstanceOf(
      SyntaxError,
    );
  });
});
