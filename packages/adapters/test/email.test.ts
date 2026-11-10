// The e-mail adapters (P6-06, ADR 0077, D5):
// - the Null adapter records { locale, recipientHash } only: never the
//   address, the subject or the text (they can hold an invitation link);
//   `capture` alone sees the whole message; scripted failures reject in
//   order, then sends succeed (the worker's retry test uses this);
// - the Mailpit adapter posts Mailpit's send API shape, refuses a non-2xx
//   answer and a network failure with EmailSendError (status only, never
//   a value), and follows no redirect;
// - both are Null adapters: the registry refuses each in production.
import { describe, expect, test } from "vitest";
import {
  EmailSendError,
  MAILPIT_TIMEOUT_MS,
  createMailpitEmail,
  createNullEmail,
} from "../src/email.ts";
import { AdapterRegistryError, buildRegistry } from "../src/registry.ts";
import type { EmailMessage } from "../src/types.ts";

const TOKEN = "af-south-1.zz_secret_token_sentinel_0001";
const message: EmailMessage = Object.freeze({
  to: "invitee@example.com",
  locale: "fr",
  subject: "Invitation",
  text: `Open https://app.example/invite#${TOKEN}`,
});

describe("createNullEmail()", () => {
  test("records and logs the locale and a keyed hash only", async () => {
    const logged: unknown[] = [];
    const email = createNullEmail({ log: (entry) => logged.push(entry) });
    await email.send(message);
    expect(email.sent).toHaveLength(1);
    expect(logged).toEqual(email.sent);
    const entry = email.sent[0];
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "locale",
      "recipientHash",
    ]);
    expect(entry?.locale).toBe("fr");
    expect(entry?.recipientHash).toMatch(/^[0-9a-f]{8}$/);
    const dump = JSON.stringify([email.sent, logged]);
    for (const value of [message.to, TOKEN, message.subject, "invite#"]) {
      expect(dump).not.toContain(value);
    }
  });

  test("the hash is keyed per instance: two instances disagree", async () => {
    const a = createNullEmail();
    const b = createNullEmail();
    await a.send(message);
    await b.send(message);
    await a.send(message);
    expect(a.sent[0]?.recipientHash).toBe(a.sent[1]?.recipientHash);
    expect(a.sent[0]?.recipientHash).not.toBe(b.sent[0]?.recipientHash);
  });

  test("capture receives the whole message; sent stays frozen", async () => {
    const captured: EmailMessage[] = [];
    const email = createNullEmail({ capture: (m) => captured.push(m) });
    await email.send(message);
    expect(captured).toEqual([message]);
    expect(Object.isFrozen(email.sent)).toBe(true);
    expect(Object.isFrozen(email)).toBe(true);
  });

  test("scripted failures reject in order, then sends succeed", async () => {
    const boom = new Error("provider down");
    const email = createNullEmail({ failures: [boom, boom] });
    await expect(email.send(message)).rejects.toBe(boom);
    await expect(email.send(message)).rejects.toBe(boom);
    await expect(email.send(message)).resolves.toBeUndefined();
    expect(email.sent).toHaveLength(1);
  });

  test("descriptor: null_email, kind email, a Null adapter", () => {
    expect(createNullEmail()).toMatchObject({
      id: "null_email",
      kind: "email",
      nullAdapter: true,
    });
  });
});

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

const fakeFetch =
  (status: number, calls: Call[]): typeof fetch =>
  (url, init) => {
    calls.push({
      url: url instanceof Request ? url.url : url.toString(),
      init: init ?? {},
    });
    return Promise.resolve(new Response("{}", { status }));
  };

describe("createMailpitEmail()", () => {
  test("posts Mailpit's send API shape to <url>/api/v1/send", async () => {
    const calls: Call[] = [];
    const email = createMailpitEmail({
      url: "http://127.0.0.1:8025",
      from: "no-reply@bricx.invalid",
      fetch: fakeFetch(200, calls),
    });
    await email.send(message);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe("http://127.0.0.1:8025/api/v1/send");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.redirect).toBe("error");
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    const body = call?.init.body;
    expect(typeof body).toBe("string");
    expect(JSON.parse(typeof body === "string" ? body : "")).toEqual({
      From: { Email: "no-reply@bricx.invalid" },
      To: [{ Email: message.to }],
      Subject: message.subject,
      Text: message.text,
      Headers: { "Content-Language": "fr" },
    });
    expect(MAILPIT_TIMEOUT_MS).toBe(5_000);
  });

  test.each([400, 500, 503])(
    "HTTP %i: EmailSendError with the status, never a value",
    async (status) => {
      const email = createMailpitEmail({
        url: "http://127.0.0.1:8025",
        from: "no-reply@bricx.invalid",
        fetch: fakeFetch(status, []),
      });
      const error = await email.send(message).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(EmailSendError);
      expect((error as EmailSendError).status).toBe(status);
      const text = (error as Error).message;
      expect(text).not.toContain(message.to);
      expect(text).not.toContain(TOKEN);
      expect((error as Error).name).toBe("EmailSendError");
    },
  );

  test("a network failure: EmailSendError without a status or the cause", async () => {
    const email = createMailpitEmail({
      url: "http://127.0.0.1:8025",
      from: "no-reply@bricx.invalid",
      fetch: () =>
        Promise.reject(new Error(`connect ECONNREFUSED ${message.to}`)),
    });
    const error = await email.send(message).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(EmailSendError);
    expect((error as EmailSendError).status).toBeUndefined();
    expect((error as Error).message).toBe("email send failed: no answer");
  });

  test("descriptor: mailpit_email, a Null adapter refused in production", () => {
    const email = createMailpitEmail({
      url: "http://127.0.0.1:8025",
      from: "no-reply@bricx.invalid",
    });
    expect(email).toMatchObject({
      id: "mailpit_email",
      kind: "email",
      nullAdapter: true,
    });
    for (const adapter of [email, createNullEmail()]) {
      let refused: unknown;
      try {
        buildRegistry([adapter], { nodeEnv: "production" });
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(AdapterRegistryError);
      expect((refused as AdapterRegistryError).code).toBe("null_in_production");
    }
  });
});
