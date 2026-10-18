// A headless browser for the live login tests (P5-01 review, ADR 0060):
// follows Keycloak's login pages with a cookie jar and no automatic
// redirects, fills the forms the bricx flows show, and computes TOTP codes
// the way the OTP form expects (RFC 6238, SHA-1, 6 digits, 30 s).
import { createHash, createHmac, randomBytes } from "node:crypto";

export interface Page {
  readonly status: number;
  readonly location: string;
  readonly body: string;
}

export interface Tokens {
  readonly access_token: string;
  readonly refresh_token: string;
}

export class Browser {
  private readonly cookies = new Map<string, string>();

  constructor(private readonly base: string) {}

  /** GET or form POST, never following redirects; cookies kept per name. */
  async request(url: string, form?: Record<string, string>): Promise<Page> {
    const absolute = url.startsWith("/") ? `${this.base}${url}` : url;
    const headers: Record<string, string> = {};
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies]
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
    }
    const init: RequestInit = { redirect: "manual", headers };
    if (form !== undefined) {
      init.method = "POST";
      init.body = new URLSearchParams(form);
    }
    const response = await fetch(absolute, init);
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (/max-age=0/i.test(cookie) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return {
      status: response.status,
      location: response.headers.get("location") ?? "",
      body: await response.text(),
    };
  }

  /** Follows redirects that stay on Keycloak; stops at the app's redirect. */
  async follow(page: Page): Promise<Page> {
    let current = page;
    while (current.status === 302 && current.location.startsWith(this.base)) {
      current = await this.request(current.location);
    }
    return current;
  }
}

/** The first form's action URL on a Keycloak page. */
export function formAction(page: Page): string {
  const match = /<form[^>]*action="([^"]+)"/.exec(page.body);
  if (match?.[1] === undefined) throw new Error("the page has no form");
  return unescapeHtml(match[1]);
}

/** The TOTP secret on Keycloak's OTP setup page, or undefined. */
export function totpSecretOf(page: Page): string | undefined {
  const match = /name="totpSecret" value="([^"]+)"/.exec(page.body);
  return match?.[1] === undefined ? undefined : unescapeHtml(match[1]);
}

function unescapeHtml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

/** The current TOTP code for a secret shown by Keycloak's setup form. */
export function totp(secret: string, nowMs: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / 30_000)));
  const digest = createHmac("sha1", Buffer.from(secret, "utf8"))
    .update(counter)
    .digest();
  const offset = (digest.at(-1) ?? 0) & 15;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}

/** A PKCE pair (S256). */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** The decoded payload of a JWT (no signature check: test-only reading). */
export function claimsOf(jwt: string): Record<string, unknown> {
  const payload = jwt.split(".")[1] ?? "";
  const parsed: unknown = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  );
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("the token payload is not an object");
  }
  return Object.fromEntries(Object.entries(parsed));
}
