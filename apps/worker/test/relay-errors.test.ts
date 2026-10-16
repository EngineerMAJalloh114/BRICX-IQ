// P4-06 (condition 1): which publish failures are the infrastructure's
// (Valkey unreachable or timing out: attempts unchanged, global backoff)
// and which are the row's (attempts + 1, dead-letter at N). A failure not
// recognised as infrastructure is the row's only if Valkey still answers a
// PING (relay.ts probes it); that probe is proved in relay.int.test.ts.
import { describe, expect, test } from "vitest";
import {
  PublishTimeoutError,
  isInfrastructureError,
} from "../src/relay/errors.js";

const withCode = (code: string) =>
  Object.assign(new Error(`connect ${code} 10.0.0.1:6379`), { code });
const named = (name: string, message: string) => {
  const error = new Error(message);
  Object.defineProperty(error, "name", { value: name });
  return error;
};

describe("isInfrastructureError", () => {
  test.each<[string, unknown]>([
    ["ECONNREFUSED", withCode("ECONNREFUSED")],
    ["ECONNRESET", withCode("ECONNRESET")],
    ["ETIMEDOUT", withCode("ETIMEDOUT")],
    ["ENOTFOUND", withCode("ENOTFOUND")],
    ["EAI_AGAIN", withCode("EAI_AGAIN")],
    ["EHOSTUNREACH", withCode("EHOSTUNREACH")],
    ["ENETUNREACH", withCode("ENETUNREACH")],
    ["EPIPE", withCode("EPIPE")],
    ["ioredis: connection closed", new Error("Connection is closed.")],
    ["ioredis: command timeout", new Error("Command timed out")],
    [
      "ioredis: offline queue disabled",
      new Error(
        "Stream isn't writeable and enableOfflineQueue options is false",
      ),
    ],
    [
      "ioredis: retries exhausted",
      named(
        "MaxRetriesPerRequestError",
        "Reached the max retries per request limit (which is 1).",
      ),
    ],
    ["the relay's own publish timeout", new PublishTimeoutError()],
    [
      "Valkey OOM (noeviction at maxmemory)",
      named(
        "ReplyError",
        "OOM command not allowed when used memory > 'maxmemory'.",
      ),
    ],
    [
      "Valkey loading",
      named("ReplyError", "LOADING Valkey is loading the dataset in memory"),
    ],
    [
      "Valkey busy script",
      named("ReplyError", "BUSY Valkey is busy running a script."),
    ],
    [
      "Valkey read-only replica",
      named(
        "ReplyError",
        "READONLY You can't write against a read only replica.",
      ),
    ],
    ["Valkey auth", named("ReplyError", "NOAUTH Authentication required.")],
    [
      "Valkey wrong password",
      named("ReplyError", "WRONGPASS invalid username-password pair"),
    ],
    [
      "Valkey persistence failure",
      named("ReplyError", "MISCONF Errors writing to the AOF file"),
    ],
    [
      "Valkey master down",
      named("ReplyError", "MASTERDOWN Link with MASTER is down"),
    ],
    [
      "Valkey cluster down",
      named("ReplyError", "CLUSTERDOWN The cluster is down"),
    ],
    [
      "Valkey try again",
      named("ReplyError", "TRYAGAIN Multiple keys request during rehashing"),
    ],
  ])("%s is infrastructure", (_what, error) => {
    expect(isInfrastructureError(error)).toBe(true);
  });

  test.each<[string, unknown]>([
    ["a plain Error", new Error("Invalid job options")],
    ["a script error", named("ReplyError", "ERR Error running script")],
    ["a TypeError", new TypeError("x is not a function")],
    ["a string", "Connection is closed."],
    ["undefined", undefined],
    ["an object with a code", { code: "ECONNREFUSED" }],
  ])("%s is not recognised as infrastructure", (_what, error) => {
    expect(isInfrastructureError(error)).toBe(false);
  });
});

describe("PublishTimeoutError", () => {
  test("names itself and carries no detail", () => {
    const error = new PublishTimeoutError();
    expect(error.name).toBe("PublishTimeoutError");
    expect(error.message).toBe("publish timed out");
    expect(Object.keys(error)).toEqual([]);
  });
});
