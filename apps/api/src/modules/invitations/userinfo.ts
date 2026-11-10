// The cell Keycloak's userinfo endpoint (P6-06, ADR 0077, D6; owner
// condition C3): where accept learns the caller's verified e-mail, so no
// access token carries an address.
// - The URL comes from the cell's config only (auth.userinfoUrl, derived
//   from KEYCLOAK_ISSUER), never from a token or the request.
// - One GET with the caller's own bearer token, 2 s timeout, no redirect,
//   no cache (each accept asks again; nothing is kept).
// - The answer is bounded (16 KiB) and parsed strictly: `sub` must be a
//   string, `email_verified` is true only when it is the boolean true,
//   and `email` is kept only as a string (the caller normalises it with
//   the invite's normaliser).
// - A 401 or 403 is UserinfoRefused (the token is not good at Keycloak:
//   401 for the caller); anything else (network, timeout, 5xx, a body
//   that is not the shape) is UserinfoUnavailable (503). Errors carry no
//   value; nothing here logs.

/** How long one userinfo call may take (D6). */
export const USERINFO_TIMEOUT_MS = 2_000;
/** Most bytes of a userinfo answer read. */
export const USERINFO_MAX_BYTES = 16 * 1024;

export interface UserinfoAnswer {
  readonly sub: string;
  readonly email: string | undefined;
  /** True only for the boolean true (C3). */
  readonly emailVerified: boolean;
}

export class UserinfoUnavailable extends Error {
  constructor() {
    super("userinfo unavailable");
  }
}
Object.defineProperty(UserinfoUnavailable.prototype, "name", {
  value: "UserinfoUnavailable",
});

export class UserinfoRefused extends Error {
  constructor() {
    super("userinfo refused the token");
  }
}
Object.defineProperty(UserinfoRefused.prototype, "name", {
  value: "UserinfoRefused",
});

export interface UserinfoClient {
  /** The caller's userinfo, asked with their own bearer token. */
  read(bearer: string): Promise<UserinfoAnswer>;
}

export const USERINFO_CLIENT = Symbol("USERINFO_CLIENT");

export interface UserinfoOptions {
  /** auth.userinfoUrl from the API config. */
  readonly url: string;
  readonly timeoutMs?: number;
  /** Tests only: a stand-in for the platform fetch. */
  readonly fetch?: typeof fetch;
}

/** The body as text, refused past USERINFO_MAX_BYTES (declared or read). */
async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > USERINFO_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new UserinfoUnavailable();
  }
  // The timeout signal bounds the read of an undeclared length.
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > USERINFO_MAX_BYTES) throw new UserinfoUnavailable();
  return Buffer.from(bytes).toString("utf8");
}

export function createUserinfoClient(options: UserinfoOptions): UserinfoClient {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? USERINFO_TIMEOUT_MS;
  return {
    async read(bearer) {
      let response: Response;
      try {
        response = await doFetch(options.url, {
          method: "GET",
          headers: {
            authorization: `Bearer ${bearer}`,
            accept: "application/json",
          },
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new UserinfoUnavailable();
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined);
        throw new UserinfoRefused();
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new UserinfoUnavailable();
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await boundedText(response));
      } catch {
        throw new UserinfoUnavailable();
      }
      if (typeof parsed !== "object" || parsed === null) {
        throw new UserinfoUnavailable();
      }
      const sub: unknown = Reflect.get(parsed, "sub");
      const email: unknown = Reflect.get(parsed, "email");
      const verified: unknown = Reflect.get(parsed, "email_verified");
      if (typeof sub !== "string" || sub.length === 0) {
        throw new UserinfoUnavailable();
      }
      return {
        sub,
        email: typeof email === "string" ? email : undefined,
        emailVerified: verified === true,
      };
    },
  };
}
