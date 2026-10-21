// P4-01: bootstrap() listens on config.http.port, on loopback outside
// production (D5 plan note: for architect review).
import { createServer } from "node:net";
import { loadApiConfig } from "@bricx/config/api";
import { describe, expect, test } from "vitest";
import { bootstrap, listenHost } from "../src/bootstrap.js";
import { apiEnv } from "./env.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === "string")
    throw new Error("no port");
  return address.port;
}

describe("bootstrap", () => {
  test("listens on API_PORT on 127.0.0.1 and serves /health/live", async () => {
    const port = await freePort();
    const app = await bootstrap(
      loadApiConfig(apiEnv({ API_PORT: String(port), LOG_LEVEL: "silent" })),
    );
    try {
      expect(app.getHttpServer().address()).toMatchObject({
        address: "127.0.0.1",
        port,
      });
      const res = await fetch(`http://127.0.0.1:${String(port)}/health/live`);
      expect(res.status).toBe(200);
    } finally {
      await app.close();
    }
  });

  test("binds all interfaces only in production", () => {
    expect(listenHost(loadApiConfig(apiEnv({ NODE_ENV: "development" })))).toBe(
      "127.0.0.1",
    );
    expect(listenHost(loadApiConfig(apiEnv({ NODE_ENV: "test" })))).toBe(
      "127.0.0.1",
    );
    const production = loadApiConfig(
      apiEnv({
        NODE_ENV: "production",
        DATABASE_URL:
          "postgres://bricx_app:prod-password-789@db.internal.example:5432/bricx",
        VALKEY_URL:
          "rediss://default:prod-password-012@cache.internal.example:6379",
        S3_ENDPOINT: "https://s3.eu-west-1.amazonaws.com",
        S3_REGION: "eu-west-1",
        S3_BUCKET: "bricx-prod",
        S3_ACCESS_KEY_ID: "prod-access-key-id-1",
        S3_SECRET_ACCESS_KEY: "prod-secret-access-key-1",
        CORS_ORIGINS: "https://app.bricx.example",
        // P5-02: production requires an https, remote issuer.
        KEYCLOAK_ISSUER: "https://auth.bricx.example/realms/bricx",
      }),
    );
    expect(listenHost(production)).toBe("0.0.0.0");
  });
});
