// The fetch mutator every generated operation goes through (P4-08, ADR
// 0058, decision 7). Client-safe: no Node API, no clock, no randomness;
// the fetch implementation is injected (configureApiClient), so a device,
// a web app and a test each bring their own. A non-2xx answer becomes an
// ApiProblem: its body, re-parsed with ErrorEnvelopeSchema (ADR 0047), is
// the envelope when it is one; a body that is not an envelope (a proxy's
// page, a malformed body) leaves no trace in the error.
import type { ErrorCode } from "@bricx/validation/codes";
import { ErrorEnvelopeSchema } from "@bricx/validation/error-envelope";
import type { z } from "zod";

/** The envelope as ErrorEnvelopeSchema re-parses it (ADR 0047). */
export type ProblemEnvelope = z.output<typeof ErrorEnvelopeSchema>;

export interface ApiClientOptions {
  /** "https://api.example.com" or "https://api.example.com/"; paths are joined with one slash. */
  readonly baseUrl: string;
  /** The fetch to use (globalThis.fetch when absent). */
  readonly fetch?: typeof fetch;
  /** Headers added to every request (a session token): called per request, under the call's own headers. */
  readonly headers?: () => HeadersInit | Promise<HeadersInit>;
}

export class ApiClientNotConfiguredError extends Error {
  constructor() {
    super("api client not configured: call configureApiClient() first");
  }
}
Object.defineProperty(ApiClientNotConfiguredError.prototype, "name", {
  value: "ApiClientNotConfiguredError",
});

/** A non-2xx answer. `envelope` is the problem body when it was a valid envelope. */
export class ApiProblem extends Error {
  readonly status: number;
  readonly envelope: ProblemEnvelope | undefined;

  constructor(status: number, envelope: ProblemEnvelope | undefined) {
    super(
      envelope === undefined
        ? `api problem: ${String(status)}`
        : `api problem: ${String(status)} ${envelope.code}`,
    );
    this.status = status;
    this.envelope = envelope;
  }

  get code(): ErrorCode | undefined {
    return this.envelope?.code;
  }

  get traceId(): string | undefined {
    return this.envelope?.traceId;
  }

  toJSON(): {
    name: string;
    status: number;
    envelope: ProblemEnvelope | undefined;
  } {
    return { name: this.name, status: this.status, envelope: this.envelope };
  }
}
Object.defineProperty(ApiProblem.prototype, "name", { value: "ApiProblem" });

interface Configured {
  readonly baseUrl: string;
  readonly fetch: typeof fetch;
  readonly headers: (() => HeadersInit | Promise<HeadersInit>) | undefined;
}

let configured: Configured | undefined;

export function configureApiClient(options: ApiClientOptions): void {
  configured = {
    baseUrl: options.baseUrl.replace(/\/+$/, ""),
    fetch: options.fetch ?? globalThis.fetch,
    headers: options.headers,
  };
}

/** Forgets the configuration (tests). */
export function resetApiClient(): void {
  configured = undefined;
}

async function parseProblem(
  response: Response,
): Promise<ProblemEnvelope | undefined> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  const parsed = ErrorEnvelopeSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/** What every generated operation resolves to: orval's fetch-client shape. */
export interface ApiResponse<TData> {
  readonly data: TData;
  readonly status: number;
  readonly headers: Headers;
}

/**
 * orval's mutator: sends `init` to `baseUrl + url` as JSON and resolves
 * { data, status, headers } with the parsed JSON body as data (undefined
 * for 204 or an empty body); throws ApiProblem on a non-2xx status, so the
 * error variants of a generated response type are never resolved. Headers
 * in `init` win over the configured provider's.
 */
export async function customFetch<T>(
  url: string,
  init: RequestInit,
): Promise<T> {
  if (configured === undefined) throw new ApiClientNotConfiguredError();
  const headers = new Headers(
    configured.headers === undefined ? undefined : await configured.headers(),
  );
  new Headers(init.headers).forEach((value, name) => {
    headers.set(name, value);
  });
  headers.set("accept", "application/json");
  if (
    init.body !== undefined &&
    init.body !== null &&
    !headers.has("content-type")
  ) {
    headers.set("content-type", "application/json");
  }
  const path = url.startsWith("/") ? url : `/${url}`;
  const response = await configured.fetch(`${configured.baseUrl}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    throw new ApiProblem(response.status, await parseProblem(response));
  }
  const text = response.status === 204 ? "" : await response.text();
  const data: unknown = text === "" ? undefined : JSON.parse(text);
  const result: ApiResponse<unknown> = {
    data,
    status: response.status,
    headers: response.headers,
  };
  // T is the generated operation's response type, built from this shape.
  return result as T;
}
