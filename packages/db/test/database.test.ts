// P4-01: the readiness ping is bounded, and no failure ever carries the
// connection string, the password or the driver's own message.
import { createServer, type Server, type Socket } from "node:net";
import { inspect } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import {
  DatabaseUnavailableError,
  TransactionCommitError,
  openDatabase,
  sqlstateOf,
} from "../src/database.js";

const SENTINEL = "sentinel-password-7f3a";

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
  }
});

/** A TCP server that accepts connections and never answers. */
async function silentServer(): Promise<number> {
  const server = createServer((socket) => {
    sockets.push(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  return address.port;
}

/** A port nothing listens on (bound, then released). */
async function closedPort(): Promise<number> {
  const port = await silentServer();
  const server = servers.pop();
  await new Promise((resolve) => server?.close(resolve));
  return port;
}

const url = (port: number) => ({
  reveal: () =>
    `postgres://bricx_app:${SENTINEL}@127.0.0.1:${String(port)}/bricx_dev`,
});

function expectNoSecret(error: unknown) {
  expect(error).toBeInstanceOf(DatabaseUnavailableError);
  const err = error as Error;
  for (const text of [
    err.message,
    String(err.stack),
    JSON.stringify(err),
    inspect(err, { showHidden: true, depth: 5 }),
  ]) {
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain("bricx_app");
    expect(text).not.toContain("127.0.0.1");
  }
  expect(err.cause).toBeUndefined();
}

describe("openDatabase", () => {
  test("a server that never answers fails the ping within the bound", async () => {
    const db = openDatabase(url(await silentServer()), { timeoutMs: 300 });
    const started = performance.now();
    const error: unknown = await db.ping().catch((e: unknown) => e);
    const elapsed = performance.now() - started;
    expectNoSecret(error);
    // Bound plus generous slack for a loaded runner; never the OS TCP timeout.
    expect(elapsed).toBeLessThan(10_000);
    await db.close();
  });

  test("a refused connection fails without the secret or the driver message", async () => {
    const db = openDatabase(url(await closedPort()), { timeoutMs: 300 });
    expectNoSecret(await db.ping().catch((e: unknown) => e));
    await db.close();
  });

  test("the url is revealed once, when the pool is created", () => {
    let reveals = 0;
    const db = openDatabase({
      reveal: () => {
        reveals += 1;
        return "postgres://u:p@127.0.0.1:1/d";
      },
    });
    expect(reveals).toBe(1);
    return db.close();
  });

  test("ping after close fails; close is idempotent", async () => {
    const db = openDatabase(url(await closedPort()));
    await db.close();
    await db.close();
    expectNoSecret(await db.ping().catch((e: unknown) => e));
  });

  test("the error has a stable name and no own enumerable detail", () => {
    const error = new DatabaseUnavailableError();
    expect(error.name).toBe("DatabaseUnavailableError");
    expect(Object.keys(error)).toEqual([]);
  });
});

// P4-07 (ADR 0057, amends 0053): a failure after fn resolved (at COMMIT)
// is TransactionCommitError, carrying the 5-character SQLSTATE and nothing
// else (owner condition 3); against a real Postgres in tx.int.test.ts.
describe("TransactionCommitError", () => {
  test("carries the SQLSTATE only: no message detail, no cause, a stable name", () => {
    const error = new TransactionCommitError("23505");
    expect(error.name).toBe("TransactionCommitError");
    expect(error.sqlstate).toBe("23505");
    expect(error.message).toBe("transaction commit failed");
    expect(Object.keys(error)).toEqual(["sqlstate"]);
    expect(error.cause).toBeUndefined();
    expect(error).toBeInstanceOf(Error);
  });

  test("a SQLSTATE the driver did not report is undefined; anything that is not five [0-9A-Z] is dropped", () => {
    expect(new TransactionCommitError(undefined).sqlstate).toBeUndefined();
    expect(new TransactionCommitError("ECONNRESET").sqlstate).toBeUndefined();
    expect(new TransactionCommitError("2350").sqlstate).toBeUndefined();
    expect(new TransactionCommitError("23p01").sqlstate).toBeUndefined();
    expect(new TransactionCommitError("23P01").sqlstate).toBe("23P01");
    expect(new TransactionCommitError(23505).sqlstate).toBeUndefined();
  });
});

describe("sqlstateOf(error)", () => {
  test("reads the driver's code from the error or from its cause chain, at most four deep; anything else is undefined", () => {
    const driver = Object.assign(new Error("duplicate key"), { code: "23505" });
    expect(sqlstateOf(driver)).toBe("23505");
    expect(sqlstateOf(new Error("Failed query", { cause: driver }))).toBe(
      "23505",
    );
    const deep = new Error("a", {
      cause: new Error("b", {
        cause: new Error("c", { cause: new Error("d", { cause: driver }) }),
      }),
    });
    expect(sqlstateOf(deep)).toBeUndefined();
    expect(sqlstateOf(new Error("x", { cause: "23505" }))).toBeUndefined();
    expect(
      sqlstateOf(Object.assign(new Error("reset"), { code: "ECONNRESET" })),
    ).toBeUndefined();
    expect(sqlstateOf("23505")).toBeUndefined();
    expect(sqlstateOf(undefined)).toBeUndefined();
  });
});
