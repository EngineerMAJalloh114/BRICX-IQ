// P4-06 (condition 1) without Docker: against a Valkey that refuses
// connections, the worker's client and publisher fail fast with errors the
// relay counts as infrastructure (attempts unchanged), never hang, and
// close cleanly. The same against a real, paused or stopped Valkey is in
// relay.int.test.ts; evictionPolicy() against a real Valkey in
// main.int.test.ts.
import { describe, expect, test } from "vitest";
import { isInfrastructureError } from "../src/relay/errors.js";
import { createBullPublisher } from "../src/relay/publisher.js";
import { evictionPolicy, openValkey } from "../src/relay/valkey.js";

// Port 1 on loopback: nothing listens, so connecting is refused at once.
const refused = { reveal: () => "redis://:x@127.0.0.1:1/0" };

const failure = async (work: () => Promise<unknown>): Promise<unknown> => {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
};

describe("an unreachable Valkey", () => {
  test("openValkey() is lazy: nothing connects until asked", () => {
    const client = openValkey(refused);
    try {
      expect(client.status).toBe("wait");
    } finally {
      client.disconnect();
    }
  });

  test("connect, CONFIG GET and PING fail fast as infrastructure errors", async () => {
    const client = openValkey(refused, { commandTimeoutMs: 500 });
    try {
      expect(isInfrastructureError(await failure(() => client.connect()))).toBe(
        true,
      );
      expect(
        isInfrastructureError(await failure(() => evictionPolicy(client))),
      ).toBe(true);
    } finally {
      client.disconnect();
    }
  });

  test("the publisher's add and ping fail fast as infrastructure errors; close() resolves", async () => {
    const client = openValkey(refused, { commandTimeoutMs: 500 });
    const publisher = createBullPublisher(client);
    try {
      const data = {
        outboxId: "0199e1a0-0000-7000-8000-000000000001",
        orgId: "0199e1a0-0000-7000-8000-00000000000a",
        topic: "system.ping",
        payload: {},
      };
      const started = performance.now();
      const added = await failure(() =>
        publisher.publish("system", "system.ping", data, data.outboxId),
      );
      expect(isInfrastructureError(added)).toBe(true);
      expect(isInfrastructureError(await failure(() => publisher.ping()))).toBe(
        true,
      );
      // Generous for a slow runner; a hang would hit the test timeout.
      expect(performance.now() - started).toBeLessThan(10_000);
    } finally {
      await publisher.close();
      client.disconnect();
    }
  });
});
