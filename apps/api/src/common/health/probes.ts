// Readiness probes for /health/ready: one per dependency the API cannot
// serve without. Each check is bounded (a paused peer must not hang the
// probe) and rejects with no detail; close() releases its connections.
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import type { ApiConfig } from "@bricx/config/api";
import { openDatabase } from "@bricx/db/database";
import { Redis } from "ioredis";

export interface Probe {
  check(): Promise<void>;
  close(): Promise<void>;
}

export type ProbeName = "db" | "valkey" | "s3";
export type Probes = Readonly<Record<ProbeName, Probe>>;

/** Bound on each dependency check, in milliseconds. */
export const PROBE_TIMEOUT_MS = 2_000;

class ProbeFailed extends Error {
  constructor() {
    super("probe failed");
  }
}

function dbProbe(config: ApiConfig): Probe {
  const db = openDatabase(config.database.url, {
    timeoutMs: PROBE_TIMEOUT_MS,
    maxConnections: 2,
  });
  return { check: () => db.ping(), close: () => db.close() };
}

function valkeyProbe(config: ApiConfig): Probe {
  const redis = new Redis(config.valkey.url.reveal(), {
    lazyConnect: true,
    connectTimeout: PROBE_TIMEOUT_MS,
    commandTimeout: PROBE_TIMEOUT_MS,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
  });
  // Connection errors surface through check(); unhandled they would crash.
  redis.on("error", () => undefined);
  return {
    async check() {
      try {
        if (redis.status === "wait") await redis.connect();
        await redis.ping();
      } catch {
        throw new ProbeFailed();
      }
    },
    async close() {
      redis.disconnect();
      return Promise.resolve();
    },
  };
}

function s3Probe(config: ApiConfig): Probe {
  const client = new S3Client({
    endpoint: config.s3.endpoint,
    region: config.s3.region,
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: {
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey.reveal(),
    },
  });
  return {
    async check() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: config.s3.bucket }), {
          abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
      } catch {
        throw new ProbeFailed();
      }
    },
    close() {
      client.destroy();
      return Promise.resolve();
    },
  };
}

/** The real probes for `config` (connections open lazily, on first check). */
export function createProbes(config: ApiConfig): Probes {
  return {
    db: dbProbe(config),
    valkey: valkeyProbe(config),
    s3: s3Probe(config),
  };
}
