// PowerSync healthcheck (P2-02, ADR 0035): healthy only while replication
// from Postgres works, not merely while the process is alive.
//
// The only signal PowerSync 1.26 exposes for that is its admin diagnostics
// API (POST /api/admin/v1/diagnostics, bearer token from `api.tokens`):
// the probes report process state only, and on PostgreSQL 18
// pg_stat_replication still says "streaming" after the publication is
// dropped. Healthy means: the source connection is up, its live checks
// report no fatal error (e.g. PSYNC_S1141, publication missing), the active
// sync config has no fatal error, and its initial replication is done.
//
// Runs inside the powersync container (compose.yml) and in
// tooling/db-bootstrap's powersync-health.int.test.ts. It never prints the
// token, and only calls the API on 127.0.0.1.
import process from "node:process";

/**
 * @typedef {{ level?: string, message?: string }} ReplicationError
 * @typedef {{
 *   data?: {
 *     connections?: { connected?: boolean, errors?: ReplicationError[] }[],
 *     active_sync_rules?: {
 *       connections?: { initial_replication_done?: boolean }[],
 *       errors?: ReplicationError[],
 *     },
 *   },
 * }} Diagnostics
 */

/**
 * Why replication is not healthy; empty when it is.
 * @param {Diagnostics} body
 * @returns {string[]}
 */
export function replicationProblems(body) {
  /** @type {string[]} */
  const problems = [];
  const connections = body.data?.connections ?? [];
  if (connections.length === 0) problems.push("no source connection");
  for (const connection of connections) {
    if (connection.connected !== true) {
      problems.push("source connection is down");
    }
    for (const error of connection.errors ?? []) {
      if (error.level === "fatal") {
        problems.push(`source: ${error.message ?? "fatal error"}`);
      }
    }
  }
  const active = body.data?.active_sync_rules;
  if (active === undefined) {
    problems.push("no active sync config");
  } else {
    for (const error of active.errors ?? []) {
      if (error.level === "fatal") {
        problems.push(`sync config: ${error.message ?? "fatal error"}`);
      }
    }
    const streams = active.connections ?? [];
    if (streams.length === 0) problems.push("no replication stream");
    for (const stream of streams) {
      if (stream.initial_replication_done !== true) {
        problems.push("initial replication not done");
      }
    }
  }
  return problems;
}

async function main() {
  const token = process.env["PS_API_TOKEN"] ?? "";
  if (token === "") {
    console.error("unhealthy: PS_API_TOKEN is not set");
    return 1;
  }
  try {
    const response = await fetch(
      "http://127.0.0.1:8080/api/admin/v1/diagnostics",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(4000),
      },
    );
    if (!response.ok) {
      console.error(
        `unhealthy: diagnostics answered ${String(response.status)}`,
      );
      return 1;
    }
    /** @type {unknown} */
    const body = await response.json();
    const problems = replicationProblems(/** @type {Diagnostics} */ (body));
    if (problems.length > 0) {
      console.error(`unhealthy: ${problems.join("; ")}`);
      return 1;
    }
    console.log("healthy: replication connected, no fatal errors");
    return 0;
  } catch (error) {
    const name = error instanceof Error ? error.name : "error";
    console.error(`unhealthy: diagnostics request failed (${name})`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main());
