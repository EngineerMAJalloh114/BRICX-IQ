// `pnpm --filter @bricx/api openapi:emit` (P4-08, ADR 0058, decision 4):
// builds the document from a throwaway app and writes it to
// packages/api-client/openapi.json, the committed input of `pnpm gen:api`.
// The app is created with stub probes, a database that is never opened
// and a fixed in-code configuration (EMIT_ENV), so the output depends on
// the sources alone: no environment file is read and no value of it can
// reach the document (test/openapi-emit.test.ts).
import { Writable } from "node:stream";
import path from "node:path";
import { loadApiConfig } from "@bricx/config/api";
import type { Database } from "@bricx/db/database";
import { createApp } from "../app.js";
import type { Probe, Probes } from "../common/health/probes.js";
import { buildOpenApiDocument, serializeOpenApiDocument } from "./document.js";

export const OPENAPI_OUTPUT_PATH = path.resolve(
  import.meta.dirname,
  "../../../../packages/api-client/openapi.json",
);

/**
 * A complete, valid, obviously fake API environment. Every value is a
 * placeholder the document test asserts is absent from the output.
 */
export const EMIT_ENV: Readonly<Record<string, string>> = Object.freeze({
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  DATABASE_URL:
    "postgres://openapi-emit:openapi-emit@openapi-emit.invalid:5432/openapi_emit",
  VALKEY_URL: "redis://openapi-emit.invalid:6379",
  S3_ENDPOINT: "http://openapi-emit.invalid:8333",
  S3_REGION: "xx-openapi-emit-1",
  S3_BUCKET: "openapi-emit",
  S3_ACCESS_KEY_ID: "openapi-emit-access-key",
  S3_SECRET_ACCESS_KEY: "openapi-emit-secret-key",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://openapi-emit.invalid:4318",
  API_PORT: "3000",
  CORS_ORIGINS: "http://openapi-emit.invalid",
});

const stubProbe: Probe = {
  check: () => Promise.resolve(),
  close: () => Promise.resolve(),
};
const stubProbes: Probes = { db: stubProbe, valkey: stubProbe, s3: stubProbe };
const noDatabase: Database = {
  ping: () => Promise.reject(new Error("openapi:emit opens no database")),
  withTx: () => Promise.reject(new Error("openapi:emit opens no database")),
  close: () => Promise.resolve(),
};

/** The document's text, from a throwaway app that never listens. */
export async function emitOpenApiDocument(): Promise<string> {
  const app = await createApp(loadApiConfig(EMIT_ENV), {
    probes: stubProbes,
    database: noDatabase,
    logStream: new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    }),
  });
  try {
    await app.init();
    return serializeOpenApiDocument(buildOpenApiDocument(app));
  } finally {
    await app.close();
  }
}
