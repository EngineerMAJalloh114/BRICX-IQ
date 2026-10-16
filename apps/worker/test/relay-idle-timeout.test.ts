// P4-06 (ADR 0056, owner review of PR #52): bricx_relay's
// idle_in_transaction_session_timeout must outlast a whole batch with a
// margin. The gap between the claim and the mark can be the batch deadline
// plus one bounded Valkey command; the role's timeout sits at least 5 s
// above that, so Postgres never ends a healthy batch's transaction.
// The value is read from the dev bootstrap (the one place that sets it) and
// from the bootstrap checker's expectation, which must agree.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { RELAY_DEFAULTS } from "../src/relay/relay.js";

const repo = path.resolve(import.meta.dirname, "../../..");
const MARGIN_MS = 5_000;

function seconds(found: RegExpExecArray | null, where: string): number {
  if (found?.[1] === undefined) throw new Error(`no timeout in ${where}`);
  return Number(found[1]) * 1_000;
}

const bootstrapMs = seconds(
  /ALTER ROLE bricx_relay SET idle_in_transaction_session_timeout = '(\d+)s';/.exec(
    readFileSync(
      path.join(repo, "infrastructure/docker/postgres/init/01-bootstrap.sh"),
      "utf8",
    ),
  ),
  "01-bootstrap.sh",
);
const checkerMs = seconds(
  /"idle_in_transaction_session_timeout=(\d+)s"/.exec(
    readFileSync(path.join(repo, "tooling/db-bootstrap/src/checks.ts"), "utf8"),
  ),
  "tooling/db-bootstrap/src/checks.ts",
);

describe("bricx_relay idle_in_transaction_session_timeout", () => {
  test("is at least 5 s above batchDeadlineMs + commandTimeoutMs", () => {
    const longestBatchMs =
      RELAY_DEFAULTS.batchDeadlineMs + RELAY_DEFAULTS.commandTimeoutMs;
    expect(bootstrapMs).toBeGreaterThanOrEqual(longestBatchMs + MARGIN_MS);
  });

  test("the bootstrap checker expects the value the bootstrap sets", () => {
    expect(checkerMs).toBe(bootstrapMs);
  });
});
