// P6-01 (ADR 0071, D6): resolveCell() asks the global directory which cell
// serves an organisation, before the client has a token or knows its API.
// - an e-mail address is sent as its domain only (never the address), a
//   slug as itself, both lower-cased; a malformed lookup never fetches;
// - the directory URL is required (no default) and, in production, https;
// - the answer is re-parsed with a strict schema (http(s) URLs, https in
//   production): anything else is invalid_response, never a guess;
// - 404 directory.not_found is CellNotFoundError: there is no default
//   cell; any other non-2xx is ApiProblem with the envelope;
// - errors never carry the address, the slug or the URL.
import { describe, expect, test } from "vitest";
import {
  CellNotFoundError,
  type CellLookup,
  DirectoryClientError,
  type ResolveCellOptions,
  resolveCell,
} from "../src/directory.ts";
import { ApiProblem } from "../src/fetcher.ts";

const ROUTE = {
  cell: "af-south-1",
  apiBaseUrl: "https://api.af-south-1.bricx.example",
  keycloakUrl: "https://id.af-south-1.bricx.example/realms/bricx",
};
const DIRECTORY = "https://directory.bricx.example";
const SECRET_EMAIL = "kadiatu.secret-person@acme.example";

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function fakeFetch(respond: () => Response): {
  calls: Call[];
  fetch: typeof fetch;
} {
  const calls: Call[] = [];
  const impl = (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: input instanceof Request ? input.url : String(input),
      init,
    });
    return Promise.resolve(respond());
  };
  return { calls, fetch: impl };
}

const json = (status: number, body: unknown, type = "application/json") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": type },
  });

const notFound = () =>
  json(
    404,
    {
      status: 404,
      code: "directory.not_found",
      key: "errors:directory.not_found",
      traceId: "0199e1a0-0000-7000-8000-00000000aaaa",
    },
    "application/problem+json",
  );

async function failure(
  lookup: CellLookup,
  options: ResolveCellOptions,
): Promise<unknown> {
  try {
    await resolveCell(lookup, options);
  } catch (error) {
    return error;
  }
  throw new Error("expected resolveCell to fail");
}

function expectNoValue(error: unknown, ...values: string[]) {
  expect(error).toBeInstanceOf(Error);
  const text = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ""}`;
  for (const value of values) expect(text).not.toContain(value);
}

describe("resolveCell(): the request", () => {
  test("an e-mail address is sent as its lower-case domain only", async () => {
    const f = fakeFetch(() => json(200, ROUTE));
    const route = await resolveCell(
      { email: "Kadiatu.Secret-Person@ACME.Example" },
      { directoryUrl: DIRECTORY, fetch: f.fetch },
    );
    expect(route).toEqual(ROUTE);
    expect(f.calls.map((c) => c.url)).toEqual([
      `${DIRECTORY}/v1/directory/resolve?email_domain=acme.example`,
    ]);
    expect(JSON.stringify(f.calls)).not.toMatch(/kadiatu/i);
    expect(f.calls[0]?.init?.method).toBe("GET");
  });

  test("a slug is sent lower-cased; a trailing slash on the directory URL is ignored", async () => {
    const f = fakeFetch(() => json(200, ROUTE));
    await resolveCell(
      { slug: "Acme-Builders" },
      { directoryUrl: `${DIRECTORY}/`, fetch: f.fetch },
    );
    expect(f.calls.map((c) => c.url)).toEqual([
      `${DIRECTORY}/v1/directory/resolve?org_slug=acme-builders`,
    ]);
  });

  test("a malformed lookup is invalid_lookup and never fetches", async () => {
    const f = fakeFetch(() => json(200, ROUTE));
    for (const lookup of [
      { email: "no-at-sign" },
      { email: "kadiatu@" },
      { email: "@acme.example" },
      { email: "a@b@acme.example" },
      { email: `kadiatu@${"a".repeat(400)}.example` },
      { email: "kadiatu@localhost" },
      { slug: "a" },
      { slug: "-acme" },
      { slug: "x".repeat(64) },
      { slug: "x".repeat(100_000) },
    ]) {
      const error = await failure(lookup, {
        directoryUrl: DIRECTORY,
        fetch: f.fetch,
      });
      expect(error).toBeInstanceOf(DirectoryClientError);
      expect((error as DirectoryClientError).code).toBe("invalid_lookup");
      // A one-letter value would match the fixed message text itself.
      expectNoValue(
        error,
        ...Object.values(lookup).filter((value) => value.length > 4),
      );
    }
    expect(f.calls).toEqual([]);
  });

  test("the directory URL is required (no default) and must be http(s); production requires https", async () => {
    const f = fakeFetch(() => json(200, ROUTE));
    for (const [directoryUrl, production] of [
      ["", false],
      ["directory.bricx.example", false],
      ["ftp://directory.bricx.example", false],
      ["https://user:pw@directory.bricx.example", false],
      ["http://directory.bricx.example", true],
    ] as const) {
      const error = await failure(
        { slug: "acme" },
        { directoryUrl, fetch: f.fetch, production },
      );
      expect(error).toBeInstanceOf(DirectoryClientError);
      expect((error as DirectoryClientError).code).toBe("insecure_url");
      if (directoryUrl !== "") expectNoValue(error, directoryUrl);
    }
    expect(f.calls).toEqual([]);
    const dev = fakeFetch(() => json(200, ROUTE));
    await resolveCell(
      { slug: "acme" },
      { directoryUrl: "http://127.0.0.1:4000", fetch: dev.fetch },
    );
    expect(dev.calls).toHaveLength(1);
  });
});

describe("resolveCell(): the answer", () => {
  test("404 directory.not_found is CellNotFoundError: no default cell", async () => {
    const error = await failure(
      { email: SECRET_EMAIL },
      { directoryUrl: DIRECTORY, fetch: fakeFetch(notFound).fetch },
    );
    expect(error).toBeInstanceOf(CellNotFoundError);
    expect((error as Error).name).toBe("CellNotFoundError");
    expectNoValue(error, SECRET_EMAIL, "acme.example", DIRECTORY);
  });

  test("any other non-2xx is ApiProblem with its envelope", async () => {
    const error = await failure(
      { slug: "acme" },
      {
        directoryUrl: DIRECTORY,
        fetch: fakeFetch(() =>
          json(
            503,
            {
              status: 503,
              code: "server_unavailable",
              key: "errors:server_unavailable",
            },
            "application/problem+json",
          ),
        ).fetch,
      },
    );
    expect(error).toBeInstanceOf(ApiProblem);
    expect((error as ApiProblem).status).toBe(503);
    expect((error as ApiProblem).code).toBe("server_unavailable");
    const plain404 = await failure(
      { slug: "acme" },
      {
        directoryUrl: DIRECTORY,
        fetch: fakeFetch(() => new Response("<html>", { status: 404 })).fetch,
      },
    );
    expect(plain404).toBeInstanceOf(ApiProblem);
  });

  test("an answer that is not exactly a cell route is invalid_response", async () => {
    for (const body of [
      {},
      { ...ROUTE, orgId: "0192d4a0-0000-7000-8000-0000000000a1" },
      { ...ROUTE, cell: "Mars" },
      { ...ROUTE, apiBaseUrl: "javascript:alert(1)" },
      { ...ROUTE, keycloakUrl: 42 },
      [ROUTE],
      "af-south-1",
    ]) {
      const error = await failure(
        { slug: "acme" },
        {
          directoryUrl: DIRECTORY,
          fetch: fakeFetch(() => json(200, body)).fetch,
        },
      );
      expect(error).toBeInstanceOf(DirectoryClientError);
      expect((error as DirectoryClientError).code).toBe("invalid_response");
    }
    const notJson = await failure(
      { slug: "acme" },
      {
        directoryUrl: DIRECTORY,
        fetch: fakeFetch(() => new Response("not json", { status: 200 })).fetch,
      },
    );
    expect((notJson as DirectoryClientError).code).toBe("invalid_response");
  });

  test("production refuses a cell route that is not https", async () => {
    for (const body of [
      { ...ROUTE, apiBaseUrl: "http://api.af-south-1.bricx.example" },
      {
        ...ROUTE,
        keycloakUrl: "http://id.af-south-1.bricx.example/realms/bricx",
      },
    ]) {
      const error = await failure(
        { slug: "acme" },
        {
          directoryUrl: DIRECTORY,
          production: true,
          fetch: fakeFetch(() => json(200, body)).fetch,
        },
      );
      expect((error as DirectoryClientError).code).toBe("invalid_response");
    }
    expect(
      await resolveCell(
        { slug: "acme" },
        {
          directoryUrl: DIRECTORY,
          production: true,
          fetch: fakeFetch(() => json(200, ROUTE)).fetch,
        },
      ),
    ).toEqual(ROUTE);
  });

  test("the errors name themselves and carry a code only", () => {
    expect(new CellNotFoundError().name).toBe("CellNotFoundError");
    expect(new CellNotFoundError().message).toBe("directory: no cell found");
    const error = new DirectoryClientError("invalid_response");
    expect(error.name).toBe("DirectoryClientError");
    expect(error.message).toBe("directory client: invalid_response");
  });
});
