// P4-07 (ADR 0057): the idempotency statements without Docker. Every
// refusal is an IdempotencyError with a code and no input value, raised
// before any SQL; the RLS helper emits the user-level policies (owner
// condition 2); the constants are the approved bounds.
import { inspect } from "node:util";
import { describe, expect, test } from "vitest";
import type { Tx } from "../src/database.js";
import {
  IDEMPOTENCY_KEY_PATTERN,
  IDEMPOTENCY_ROUTE_PATTERN,
  IDEMPOTENCY_TTL_SECONDS,
  IdempotencyError,
  MAX_RESPONSE_BYTES,
  REPLAY_HEADERS,
  REQUEST_HASH_BYTES,
  claimIdempotencyKey,
  storeIdempotencyResponse,
  validateIdempotencyKey,
} from "../src/idempotency.js";
import { SYSTEM_TENANT_TABLES, enableIdempotencyRls } from "../src/rls.js";

const SECRET = "attacker-key-DO-NOT-LEAK-5b7e21";

/** A transaction that fails the test if any SQL reaches it. */
const noSql = {
  execute: () => {
    throw new Error("SQL must not run");
  },
} as unknown as Tx;

const hash = Buffer.alloc(32, 7);
const ok = {
  route: "POST /v1/things",
  key: "0199e1a0-0000-7000-8000-00000000000a",
  requestHash: hash,
  status: 201,
};

async function refusal(
  work: () => Promise<unknown>,
): Promise<IdempotencyError> {
  const error: unknown = await work().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(IdempotencyError);
  return error as IdempotencyError;
}

describe("the bounds", () => {
  test("key: 1-255 characters of [A-Za-z0-9._~-]; route: METHOD, a space, a path without a query; 24 h; 32-byte hash; 256 KiB", () => {
    expect(IDEMPOTENCY_KEY_PATTERN.source).toBe("^[A-Za-z0-9._~-]{1,255}$");
    // Printable ASCII without "?" and "#": a query or fragment is refused.
    expect(IDEMPOTENCY_ROUTE_PATTERN.source).toBe(
      '^[A-Z]{3,10} \\/[!"$->@-~]{0,2047}$',
    );
    expect(IDEMPOTENCY_TTL_SECONDS).toBe(86_400);
    expect(REQUEST_HASH_BYTES).toBe(32);
    expect(MAX_RESPONSE_BYTES).toBe(262_144);
    expect([...REPLAY_HEADERS]).toEqual(["content-type", "location", "etag"]);
    expect(Object.isFrozen(REPLAY_HEADERS)).toBe(true);
  });

  test.each([
    ["a UUID", "0199e1a0-0000-7000-8000-00000000000a", true],
    ["one character", "k", true],
    ["255 characters", "k".repeat(255), true],
    ["the unreserved set", "aZ09._~-", true],
    ["empty", "", false],
    ["256 characters", "k".repeat(256), false],
    ["a space", "a b", false],
    ["a slash", "a/b", false],
    ["a colon", "a:b", false],
    ["a non-ASCII letter", "clé", false],
    ["a newline", "a\nb", false],
  ])("validateIdempotencyKey: %s", (_label, value, valid) => {
    if (valid) {
      expect(validateIdempotencyKey(value)).toBe(value);
    } else {
      expect(() => validateIdempotencyKey(value)).toThrow(IdempotencyError);
    }
  });

  test("a route with a query string, a lower-case method or a control character is refused", () => {
    for (const route of [
      "POST /v1/things?x=1",
      "post /v1/things",
      "POST/v1/things",
      "POST /v1/thi ngs",
      "POST /v1/\u0007",
      `POST /${"a".repeat(2048)}`,
    ]) {
      expect(IDEMPOTENCY_ROUTE_PATTERN.test(route)).toBe(false);
    }
    expect(IDEMPOTENCY_ROUTE_PATTERN.test("POST /")).toBe(true);
    expect(IDEMPOTENCY_ROUTE_PATTERN.test("PATCH /v1/a-b/c_d.e~f")).toBe(true);
  });
});

describe("refusals before any SQL", () => {
  test.each([
    ["an invalid key", { ...ok, key: SECRET + " " }, "invalid_key"],
    [
      "a route with a query",
      { ...ok, route: `POST /x?k=${SECRET}` },
      "invalid_route",
    ],
    [
      "a 31-byte hash",
      { ...ok, requestHash: Buffer.alloc(31) },
      "invalid_hash",
    ],
    [
      "a hash that is not a Buffer",
      { ...ok, requestHash: hash.toString("hex") },
      "invalid_hash",
    ],
    ["a status below 100", { ...ok, status: 99 }, "invalid_status"],
    ["a status above 599", { ...ok, status: 600 }, "invalid_status"],
    ["a fractional status", { ...ok, status: 201.5 }, "invalid_status"],
  ] as const)("claimIdempotencyKey(): %s", async (_label, claim, code) => {
    const error = await refusal(() =>
      claimIdempotencyKey(noSql, claim as unknown as typeof ok),
    );
    expect(error.code).toBe(code);
    expect(error.name).toBe("IdempotencyError");
    expect(error.message).toBe(`idempotency: ${code}`);
    expect(Object.keys(error)).toEqual(["code"]);
    for (const text of [
      String(error),
      JSON.stringify(error),
      inspect(error, { showHidden: true, depth: 5 }),
    ]) {
      expect(text).not.toContain(SECRET);
    }
  });

  test("storeIdempotencyResponse(): a body over 256 KiB is response_too_large (UTF-8 bytes, not characters)", async () => {
    const id = "0199e1a0-0000-7000-8000-00000000000b";
    // 262,144 bytes of two-byte characters is only 131,072 characters.
    const twoByte = "é".repeat(131_073);
    expect(twoByte.length).toBeLessThan(MAX_RESPONSE_BYTES);
    const error = await refusal(() =>
      storeIdempotencyResponse(noSql, id, twoByte, {}),
    );
    expect(error.code).toBe("response_too_large");
    const big = await refusal(() =>
      storeIdempotencyResponse(
        noSql,
        id,
        "x".repeat(MAX_RESPONSE_BYTES + 1),
        {},
      ),
    );
    expect(big.code).toBe("response_too_large");
  });

  test("storeIdempotencyResponse(): a header outside the allow-list, a non-string value or a bad id is refused", async () => {
    const id = "0199e1a0-0000-7000-8000-00000000000b";
    expect(
      (
        await refusal(() =>
          storeIdempotencyResponse(noSql, id, "{}", { "x-extra": "1" }),
        )
      ).code,
    ).toBe("invalid_headers");
    expect(
      (
        await refusal(() =>
          storeIdempotencyResponse(noSql, id, "{}", {
            location: 1,
          } as unknown as Record<string, string>),
        )
      ).code,
    ).toBe("invalid_headers");
    expect(
      (
        await refusal(() =>
          storeIdempotencyResponse(noSql, id, "{}", { location: "a\r\nb" }),
        )
      ).code,
    ).toBe("invalid_headers");
    expect(
      (
        await refusal(() =>
          storeIdempotencyResponse(noSql, "not-a-uuid", "{}", {}),
        )
      ).code,
    ).toBe("invalid_id");
  });
});

describe("enableIdempotencyRls() (owner condition 2)", () => {
  test("is registered as a system tenant table", () => {
    expect(SYSTEM_TENANT_TABLES).toEqual({
      "bricx.outbox": "outbox",
      "bricx.idempotency_keys": "idempotency",
    });
  });

  test("org AND user on SELECT, INSERT and UPDATE, TO bricx_app only; no owner, readonly, relay or DELETE policy", () => {
    const sqlText = enableIdempotencyRls("bricx.idempotency_keys");
    const scope =
      "(org_id = app.current_org() AND user_id = app.current_user_id())";
    expect(sqlText.split("\n--> statement-breakpoint\n")).toEqual([
      '-- RLS for bricx.idempotency_keys: system tenant table (enableIdempotencyRls, ADR 0057)\nALTER TABLE "bricx"."idempotency_keys" ENABLE ROW LEVEL SECURITY;',
      'ALTER TABLE "bricx"."idempotency_keys" FORCE ROW LEVEL SECURITY;',
      `CREATE POLICY "idempotency_keys_app_select" ON "bricx"."idempotency_keys" AS PERMISSIVE FOR SELECT TO bricx_app USING ${scope};`,
      `CREATE POLICY "idempotency_keys_app_insert" ON "bricx"."idempotency_keys" AS PERMISSIVE FOR INSERT TO bricx_app WITH CHECK ${scope};`,
      `CREATE POLICY "idempotency_keys_app_update" ON "bricx"."idempotency_keys" AS PERMISSIVE FOR UPDATE TO bricx_app USING ${scope} WITH CHECK ${scope};`,
      'REVOKE ALL ON "bricx"."idempotency_keys" FROM bricx_app, bricx_readonly;',
      'GRANT SELECT, INSERT, UPDATE ON "bricx"."idempotency_keys" TO bricx_app;',
    ]);
    expect(sqlText).not.toContain("bricx_owner");
    expect(sqlText).not.toContain("bricx_relay");
    expect(sqlText).not.toContain("DELETE");
  });

  test("refuses a table name outside bricx or too long for the policy names", () => {
    expect(() => enableIdempotencyRls("public.x")).toThrow(
      "enableIdempotencyRls: invalid table name",
    );
    expect(() => enableIdempotencyRls(`bricx.${"a".repeat(50)}`)).toThrow(
      "enableIdempotencyRls: invalid table name",
    );
  });
});
