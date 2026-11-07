// The Null adapters (P6-04, ADR 0074; Done when 2, owner conditions C1 and
// C4):
// - payment, tax and accounting are descriptors only: no method, so the
//   Null payment adapter can never report a payment verified or paid
//   (CLAUDE.md rule 10, C4);
// - every Null adapter declares every ISO 3166 country and every current
//   ISO 4217 currency with a minor unit;
// - the Null FX provider answers `unavailable` for every pair, never an
//   invented number (D2);
// - the Null SMS adapter records and logs { templateKey, recipientHash }
//   only: recipientHash is an HMAC-SHA-256 of the number under a random
//   per-instance key, 8 hex characters. No phone number, no message text
//   and no unkeyed hash reaches any log output, the console and stdout
//   included (C1).
import { createHash, createHmac } from "node:crypto";
import { listCurrencies, parseCurrencyCode } from "@bricx/money/currency";
import { COUNTRY_CODES } from "@bricx/validation/country";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  RECIPIENT_HASH_HEX,
  RECIPIENT_KEY_BYTES,
  type NullSmsEntry,
  createNullFx,
  createNullSms,
  nullAccounting,
  nullPayment,
  nullTax,
} from "../src/null.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("descriptor-only Null adapters (D12, C4)", () => {
  test.each([
    ["payment", nullPayment, "null_payment"],
    ["tax", nullTax, "null_tax"],
    ["accounting", nullAccounting, "null_accounting"],
  ] as const)(
    "%s: id, kind, capabilities, the Null mark; no method",
    (kind, adapter, id) => {
      expect(adapter.id).toBe(id);
      expect(adapter.kind).toBe(kind);
      expect(adapter.nullAdapter).toBe(true);
      expect(Object.keys(adapter).sort()).toEqual(
        ["countries", "currencies", "id", "kind", "nullAdapter"].sort(),
      );
      for (const value of Object.values(adapter)) {
        expect(typeof value).not.toBe("function");
      }
      expect(Object.isFrozen(adapter)).toBe(true);
    },
  );

  test("the Null payment adapter has nothing that could report a payment verified or paid (C4)", () => {
    const names = new Set<string>();
    for (
      let o: object | null = nullPayment;
      o !== null && o !== Object.prototype;
      o = Object.getPrototypeOf(o) as object | null
    ) {
      for (const name of Object.getOwnPropertyNames(o)) names.add(name);
    }
    expect([...names].sort()).toEqual(
      ["countries", "currencies", "id", "kind", "nullAdapter"].sort(),
    );
  });
});

describe("capabilities: everywhere", () => {
  test.each([
    ["payment", nullPayment],
    ["tax", nullTax],
    ["accounting", nullAccounting],
    ["sms", createNullSms()],
    ["fx", createNullFx()],
  ] as const)(
    "%s declares every country and every usable currency",
    (_kind, adapter) => {
      expect(adapter.countries).toEqual(COUNTRY_CODES);
      expect(adapter.countries.length).toBeGreaterThan(240);
      expect(adapter.currencies).toEqual(listCurrencies().map((c) => c.code));
      expect(adapter.currencies).toContain("SLE");
      expect(adapter.currencies).not.toContain("SLL");
    },
  );
});

describe("createNullFx() (D2)", () => {
  test("every pair, every instant: unavailable, never a number", async () => {
    const fx = createNullFx();
    expect(fx).toMatchObject({ id: "null_fx", kind: "fx", nullAdapter: true });
    const codes = ["USD", "EUR", "SLE", "NGN", "KES", "GHS", "JPY", "BHD"];
    for (const from of codes) {
      for (const to of codes) {
        const result = await fx.rate({
          from: parseCurrencyCode(from),
          to: parseCurrencyCode(to),
          at: "2026-11-07T12:00:00.000Z",
        });
        expect(result).toEqual({ ok: false, error: "unavailable" });
      }
    }
  });
});

describe("createNullSms() (C1)", () => {
  const NUMBER = "+23276123456";
  const OTHER = "+2348031234567";
  const TEXT = "Your site visit is at 09:00, code 4417";

  const hexOf = (text: string) =>
    createHash("sha256").update(text, "utf8").digest("hex");

  test("records and logs { templateKey, recipientHash } only, the hash 8 hex characters", async () => {
    const logged: NullSmsEntry[] = [];
    const sms = createNullSms({ log: (entry) => logged.push(entry) });
    expect(sms).toMatchObject({
      id: "null_sms",
      kind: "sms",
      nullAdapter: true,
    });
    await sms.send({
      to: NUMBER,
      templateKey: "notifications:site_visit",
      params: { time: "09:00", code: "4417", text: TEXT },
    });
    expect(logged).toHaveLength(1);
    expect(Object.keys(logged[0] ?? {}).sort()).toEqual([
      "recipientHash",
      "templateKey",
    ]);
    expect(logged[0]?.templateKey).toBe("notifications:site_visit");
    expect(logged[0]?.recipientHash).toMatch(
      new RegExp(`^[0-9a-f]{${String(RECIPIENT_HASH_HEX)}}$`),
    );
    expect(RECIPIENT_HASH_HEX).toBe(8);
    expect(RECIPIENT_KEY_BYTES).toBe(32);
    expect(sms.sent).toEqual(logged);
    expect(Object.isFrozen(sms.sent)).toBe(true);
  });

  test("no phone number, no message text and no unkeyed hash in any log output", async () => {
    const consoleCalls: unknown[][] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleCalls.push(args);
      });
    }
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const logged: NullSmsEntry[] = [];
    const sms = createNullSms({ log: (entry) => logged.push(entry) });
    for (const to of [NUMBER, OTHER]) {
      await sms.send({
        to,
        templateKey: "notifications:site_visit",
        params: { text: TEXT, code: "4417" },
      });
    }
    vi.restoreAllMocks();
    const output = JSON.stringify({
      logged,
      sent: sms.sent,
      consoleCalls,
      written,
    });
    const forbidden = [
      NUMBER,
      OTHER,
      NUMBER.slice(1),
      OTHER.slice(1),
      "76123456",
      TEXT,
      "4417",
    ];
    for (const value of forbidden) expect(output).not.toContain(value);
    // No unkeyed hash of the number, whole or cut, with or without the +.
    for (const value of [NUMBER, OTHER, NUMBER.slice(1), OTHER.slice(1)]) {
      const hex = hexOf(value);
      expect(output).not.toContain(hex);
      expect(output).not.toContain(hex.slice(0, RECIPIENT_HASH_HEX));
      // Nor an HMAC under an empty key.
      const empty = createHmac("sha256", "").update(value).digest("hex");
      expect(output).not.toContain(empty.slice(0, RECIPIENT_HASH_HEX));
    }
    expect(consoleCalls).toEqual([]);
    expect(written).toEqual([]);
  });

  test("the key is per instance: one instance hashes a number the same way, another differently", async () => {
    const a = createNullSms();
    const b = createNullSms();
    const message = { to: NUMBER, templateKey: "k", params: {} };
    await a.send(message);
    await a.send(message);
    await a.send({ ...message, to: OTHER });
    await b.send(message);
    const [first, second, other] = a.sent;
    expect(first?.recipientHash).toBe(second?.recipientHash);
    expect(other?.recipientHash).not.toBe(first?.recipientHash);
    expect(b.sent[0]?.recipientHash).not.toBe(first?.recipientHash);
  });

  test("without a log callback it logs nothing and still records", async () => {
    const sms = createNullSms();
    await sms.send({ to: NUMBER, templateKey: "k", params: {} });
    expect(sms.sent).toHaveLength(1);
  });
});
