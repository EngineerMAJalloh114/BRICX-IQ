// The seed's host and user check against pg itself (P6-05b, ADR 0076;
// owner condition 3): whenever @bricx/config/seed accepts a URL, the
// connection parameters node-postgres derives from it name a local host
// (localhost, 127.0.0.1 or ::1, never a socket path) and the bricx_app
// user. The seed is stricter than that (every host and user the URL names
// must pass, so a URL whose parts disagree is refused), and the plain local
// URLs are accepted. pg is the independent oracle; nothing connects.
import { loadSeedConfig } from "@bricx/config/seed";
import pg from "pg";
import { describe, expect, it } from "vitest";

const LOCAL = new Set(["localhost", "127.0.0.1", "::1"]);

/** What pg would connect to for `url`, by its own parser. */
function pgTarget(url: string): { host: string; user: string } {
  const client = new pg.Client({ connectionString: url });
  const params = (
    client as unknown as {
      connectionParameters: { host: unknown; user: unknown };
    }
  ).connectionParameters;
  return { host: String(params.host), user: String(params.user) };
}

const accepted = (url: string): boolean => {
  try {
    loadSeedConfig({ NODE_ENV: "development", DATABASE_URL: url });
    return true;
  } catch {
    return false;
  }
};

const URLS = [
  "postgres://bricx_app:pw-1@127.0.0.1:5432/bricx_dev",
  "postgres://bricx_app:pw-1@localhost/bricx_dev",
  "postgres://bricx_app:pw-1@[::1]:5432/bricx_dev",
  "postgres://bricx_app:pw-1@db.internal.example/bricx_dev",
  "postgres://bricx_app:pw-1@127.0.0.1/bricx_dev?host=db.internal.example",
  "postgres://bricx_app:pw-1@127.0.0.1/bricx_dev?host=localhost",
  "postgres://bricx_app:pw-1@127.0.0.1/bricx_dev?host=::1",
  "postgres://bricx_app:pw-1@127.0.0.1/bricx_dev?host=/var/run/postgresql",
  "postgres://bricx_app:pw-1@%2Fvar%2Frun%2Fpostgresql/bricx_dev",
  "postgres://bricx_app:pw-1@127.0.0.1/bricx_dev?user=bricx_owner",
  "postgres://bricx_owner:pw-1@127.0.0.1/bricx_dev?user=bricx_app",
  "postgres://bricx_owner:pw-1@127.0.0.1/bricx_dev",
];

describe("seed config agrees with pg's parser", () => {
  it.each(URLS)(
    "accepted only when pg would reach bricx_app locally: %s",
    (url) => {
      const target = pgTarget(url);
      const pgSaysOk =
        LOCAL.has(target.host.toLowerCase()) && target.user === "bricx_app";
      if (accepted(url)) expect(pgSaysOk).toBe(true);
      if (!pgSaysOk) expect(accepted(url)).toBe(false);
    },
  );

  it("the plain local bricx_app URLs are accepted", () => {
    expect(URLS.filter(accepted)).toEqual([
      "postgres://bricx_app:pw-1@127.0.0.1:5432/bricx_dev",
      "postgres://bricx_app:pw-1@localhost/bricx_dev",
      "postgres://bricx_app:pw-1@[::1]:5432/bricx_dev",
      "postgres://bricx_app:pw-1@127.0.0.1/bricx_dev?host=localhost",
      "postgres://bricx_app:pw-1@127.0.0.1/bricx_dev?host=::1",
    ]);
  });
});
