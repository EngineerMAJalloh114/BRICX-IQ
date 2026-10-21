// P5-02 commit 1 (P4 point 23): the worker's logger uses the shared error
// serializer, so a database error logged by the relay or at boot keeps
// its SQLSTATE, constraint and table and never a value from its message,
// detail or a wrapper's query parameters.
import { Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { createWorkerLogger } from "../src/logger.js";

const SENTINEL = "sentinel-c41d8e09-personal-value";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
      done();
    },
  });
  return { lines, stream };
}

describe("the worker logger", () => {
  test("a database error under err or error: SQLSTATE, constraint, table; no value", () => {
    const { lines, stream } = capture();
    const logger = createWorkerLogger("info", stream);
    const cause = Object.assign(new Error(`duplicate key: ${SENTINEL}`), {
      code: "23505",
      detail: `Key (k)=(${SENTINEL}) already exists.`,
      constraint: "fx_k",
      table: "fx",
    });
    // Drizzle's wrapper shape: the query and params in the message.
    const wrapped = new Error(`Failed query: SELECT $1\nparams: ${SENTINEL}`, {
      cause,
    });
    logger.error({ err: wrapped }, "outbox.test_failed");
    logger.error({ error: wrapped }, "outbox.test_failed");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toContain(SENTINEL);
      const parsed = JSON.parse(line) as Record<
        string,
        Record<string, unknown>
      >;
      const logged = parsed.err ?? parsed.error;
      expect(logged).toMatchObject({
        sqlstate: "23505",
        constraint: "fx_k",
        table: "fx",
      });
    }
  });

  test("lines carry service worker and the configured level", () => {
    const { lines, stream } = capture();
    const logger = createWorkerLogger("warn", stream);
    logger.info({}, "worker.quiet");
    logger.warn({}, "worker.loud");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      service: "worker",
      msg: "worker.loud",
    });
  });
});
