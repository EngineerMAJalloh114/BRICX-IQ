// P5-02 commit 1 (P4 point 23, ADR 0057 amended by ADR 0062): the error
// serializer every service logger uses. A database error is logged as its
// SQLSTATE, constraint, table, column and stack frames only: never the
// message (pg quotes input values in it: invalid input syntax for type
// uuid: "<value>"), detail (Key (k)=(<value>)), where, the query text or
// its parameters (Drizzle's "Failed query: ... params: ...").
import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, test } from "vitest";
import { TransactionCommitError } from "../src/database.js";
import { serializeError } from "../src/log.js";

const SENTINEL = "sentinel-7f3a91c2-personal-value";

/** A node-postgres DatabaseError as the driver builds it. */
function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), {
    name: "error",
    severity: "ERROR",
    code,
    detail: `Key (k)=(${SENTINEL}) already exists.`,
    hint: `try ${SENTINEL}`,
    where: `SQL function "f" statement 1: ${SENTINEL}`,
    internalQuery: `SELECT '${SENTINEL}'`,
    schema: "bricx",
    table: "fx_people",
    column: "k",
    dataType: "text",
    constraint: "fx_people_k",
    file: "nbtinsert.c",
    line: "666",
    routine: "_bt_check_unique",
  });
}

const text = (value: unknown) => JSON.stringify(value);

describe("serializeError: database errors", () => {
  test("a driver error keeps SQLSTATE, constraint, schema, table, column and stack frames; nothing that can quote a value", () => {
    const logged = serializeError(
      pgError("23505", `duplicate key value: ${SENTINEL}`),
    );
    expect(text(logged)).not.toContain(SENTINEL);
    expect(logged).toMatchObject({
      type: "error",
      sqlstate: "23505",
      constraint: "fx_people_k",
      schema: "bricx",
      table: "fx_people",
      column: "k",
    });
    expect(logged).not.toHaveProperty("message");
    expect(logged).not.toHaveProperty("detail");
    expect(logged).not.toHaveProperty("where");
    expect(logged).not.toHaveProperty("hint");
    expect(logged).not.toHaveProperty("internalQuery");
    expect(logged.stack).toMatch(/^ {4}at /);
    expect(logged.stack).toContain("log.test.ts");
  });

  test("an invalid-input error (22P02) whose message quotes the value: the message is dropped", () => {
    const logged = serializeError(
      pgError("22P02", `invalid input syntax for type uuid: "${SENTINEL}"`),
    );
    expect(text(logged)).not.toContain(SENTINEL);
    expect(logged.sqlstate).toBe("22P02");
  });

  test("Drizzle's wrapper (query text and params in its message and fields) around the driver's error", () => {
    const cause = pgError("23505", `duplicate key value: ${SENTINEL}`);
    const wrapped = new DrizzleQueryError(
      `INSERT INTO bricx.fx_people (k) VALUES ($1) -- ${SENTINEL}`,
      [SENTINEL, { nested: SENTINEL }],
      cause,
    );
    const logged = serializeError(wrapped);
    expect(text(logged)).not.toContain(SENTINEL);
    expect(logged).toMatchObject({
      type: "DrizzleQueryError",
      sqlstate: "23505",
      constraint: "fx_people_k",
      table: "fx_people",
    });
    expect(logged).not.toHaveProperty("query");
    expect(logged).not.toHaveProperty("params");
    expect(logged).not.toHaveProperty("cause");
  });

  test("Drizzle's wrapper without a SQLSTATE in the chain (a driver connection error) is still a database error", () => {
    const wrapped = new DrizzleQueryError(
      `SELECT '${SENTINEL}'`,
      [SENTINEL],
      new Error(`Connection terminated: ${SENTINEL}`),
    );
    const logged = serializeError(wrapped);
    expect(text(logged)).not.toContain(SENTINEL);
    expect(logged.type).toBe("DrizzleQueryError");
    expect(logged).not.toHaveProperty("sqlstate");
  });

  test("a database error deeper in a cause chain makes the whole chain a database error", () => {
    const outer = new Error(`handler failed for ${SENTINEL}`, {
      cause: new Error(`repository: ${SENTINEL}`, {
        cause: pgError("23503", `violates foreign key: ${SENTINEL}`),
      }),
    });
    const logged = serializeError(outer);
    expect(text(logged)).not.toContain(SENTINEL);
    expect(logged).toMatchObject({ type: "Error", sqlstate: "23503" });
  });

  test("TransactionCommitError keeps its SQLSTATE", () => {
    const logged = serializeError(new TransactionCommitError("40001"));
    expect(logged).toMatchObject({
      type: "TransactionCommitError",
      sqlstate: "40001",
    });
  });

  test("identifier fields that are not short identifiers are dropped", () => {
    const odd = Object.assign(pgError("23505", "x"), {
      table: `fx people ${SENTINEL}`,
      column: "k".repeat(200),
      constraint: 42,
    });
    const logged = serializeError(odd);
    expect(text(logged)).not.toContain(SENTINEL);
    expect(logged).not.toHaveProperty("table");
    expect(logged).not.toHaveProperty("column");
    expect(logged).not.toHaveProperty("constraint");
  });
});

describe("serializeError: other errors", () => {
  test("an ordinary error keeps its type, message and stack", () => {
    const logged = serializeError(new TypeError("cannot read x of undefined"));
    expect(logged).toMatchObject({
      type: "TypeError",
      message: "cannot read x of undefined",
    });
    expect(logged.stack).toContain("TypeError: cannot read x of undefined");
  });

  test("its cause chain is kept, bounded to 5 levels", () => {
    let error: Error = new Error("level 0");
    for (let i = 1; i <= 10; i += 1) {
      error = new Error(`level ${String(i)}`, { cause: error });
    }
    let logged = serializeError(error);
    let depth = 1;
    while (logged.cause !== undefined) {
      logged = logged.cause;
      depth += 1;
    }
    expect(depth).toBe(5);
  });

  test("a long message and stack are cut", () => {
    const logged = serializeError(new Error("m".repeat(10_000)));
    expect(logged.message?.length).toBeLessThanOrEqual(1_000);
    expect(logged.stack?.length).toBeLessThanOrEqual(4_000);
  });

  test("a value that is not an Error is logged by its type only", () => {
    expect(serializeError(SENTINEL)).toEqual({ type: "string" });
    expect(serializeError({ password: SENTINEL })).toEqual({ type: "object" });
    expect(serializeError(null)).toEqual({ type: "null" });
    expect(serializeError(undefined)).toEqual({ type: "undefined" });
  });

  test("enumerable extra fields of an ordinary error are not logged", () => {
    const error = Object.assign(new Error("failed"), {
      body: SENTINEL,
      config: { headers: { authorization: SENTINEL } },
    });
    expect(text(serializeError(error))).not.toContain(SENTINEL);
  });
});
