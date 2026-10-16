// P4-06 (ADR 0056): the relay's database handle without Docker. Like
// openDatabase, a failure never carries the connection string, the password
// or the driver's message, and nothing runs on a connection that failed.
// The role check, the statement timeout and nesting against a real
// Postgres are in outbox.int.test.ts.
import { createServer } from "node:net";
import { inspect } from "node:util";
import { describe, expect, test } from "vitest";
import {
  DatabaseUnavailableError,
  RELAY_ROLE,
  RelayRoleError,
  openRelayDatabase,
} from "../src/database.js";

const SENTINEL = "sentinel-relay-password-51c2";

/** A port nothing listens on (bound, then released). */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === "string") {
    throw new Error("no port");
  }
  return address.port;
}

const url = (port: number) => ({
  reveal: () =>
    `postgres://bricx_relay:${SENTINEL}@127.0.0.1:${String(port)}/bricx_dev`,
});

function expectNoSecret(error: unknown) {
  expect(error).toBeInstanceOf(DatabaseUnavailableError);
  for (const text of [
    String(error),
    JSON.stringify(error),
    inspect(error, { showHidden: true, depth: 5 }),
  ]) {
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain("bricx_relay@");
    expect(text).not.toContain("127.0.0.1");
  }
  expect(error).not.toHaveProperty("cause");
}

describe("openRelayDatabase", () => {
  test("RELAY_ROLE is bricx_relay; RelayRoleError names itself and carries no detail", () => {
    expect(RELAY_ROLE).toBe("bricx_relay");
    const error = new RelayRoleError();
    expect(error.name).toBe("RelayRoleError");
    expect(error.message).toBe("relay transaction: not bricx_relay");
    expect(Object.keys(error)).toEqual([]);
  });

  test("the url is revealed once, when the pool is created", async () => {
    let reveals = 0;
    const db = openRelayDatabase({
      reveal: () => {
        reveals += 1;
        return "postgres://u:p@127.0.0.1:1/d";
      },
    });
    expect(reveals).toBe(1);
    await db.close();
  });

  test("a refused connection: ping and withRelayTx fail without the secret, and fn never runs", async () => {
    const db = openRelayDatabase(url(await closedPort()), { timeoutMs: 300 });
    try {
      expectNoSecret(await db.ping().catch((e: unknown) => e));
      let ran = false;
      const error = await db
        .withRelayTx(() => {
          ran = true;
          return Promise.resolve();
        })
        .catch((e: unknown) => e);
      expectNoSecret(error);
      expect(ran).toBe(false);
    } finally {
      await db.close();
    }
  });

  test("after close, ping and withRelayTx fail; close is idempotent", async () => {
    const db = openRelayDatabase(url(await closedPort()));
    await db.close();
    await db.close();
    expectNoSecret(await db.ping().catch((e: unknown) => e));
    expectNoSecret(
      await db.withRelayTx(() => Promise.resolve()).catch((e: unknown) => e),
    );
  });
});
