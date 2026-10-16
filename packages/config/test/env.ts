// Valid environments for the tests: every declared key with a plausible
// value. Production values are fake but contain nothing the production
// guards reject.

export const devApiEnv = {
  NODE_ENV: "development",
  LOG_LEVEL: "debug",
  DATABASE_URL:
    "postgres://bricx_app:test-password-123@127.0.0.1:5432/bricx_dev",
  VALKEY_URL: "redis://default:test-password-456@127.0.0.1:6379",
  S3_ENDPOINT: "http://127.0.0.1:8333",
  S3_REGION: "us-east-1",
  S3_BUCKET: "bricx-dev",
  S3_ACCESS_KEY_ID: "test-access-key-id-1",
  S3_SECRET_ACCESS_KEY: "test-secret-access-key-1",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
  API_PORT: "4000",
  CORS_ORIGINS: "http://localhost:8081,http://127.0.0.1:8081",
} as const;

export const prodApiEnv = {
  ...devApiEnv,
  NODE_ENV: "production",
  LOG_LEVEL: "info",
  DATABASE_URL:
    "postgres://bricx_app:prod-password-789@db.internal.example:5432/bricx",
  VALKEY_URL: "rediss://default:prod-password-012@cache.internal.example:6379",
  S3_ENDPOINT: "https://s3.eu-west-1.amazonaws.com",
  S3_REGION: "eu-west-1",
  S3_BUCKET: "bricx-prod",
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.internal.example:4318",
  CORS_ORIGINS: "https://app.bricx.example,https://admin.bricx.example",
} as const;

/** The shared keys plus the relay's bricx_relay URL (P4-06). */
export const devWorkerEnv = {
  ...without(without(devApiEnv, "API_PORT"), "CORS_ORIGINS"),
  RELAY_DATABASE_URL:
    "postgres://bricx_relay:test-password-321@127.0.0.1:5432/bricx_dev",
} as const;

export const prodWorkerEnv = {
  ...without(without(prodApiEnv, "API_PORT"), "CORS_ORIGINS"),
  RELAY_DATABASE_URL:
    "postgres://bricx_relay:prod-password-654@db.internal.example:5432/bricx",
} as const;

export const devClientEnv = {
  EXPO_PUBLIC_API_URL: "http://127.0.0.1:4000",
} as const;

/** `env` without `key`. */
export function without<T extends object>(env: T, key: keyof T): Partial<T> {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => name !== key),
  ) as Partial<T>;
}
