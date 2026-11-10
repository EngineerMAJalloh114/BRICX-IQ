// P6-06 (ADR 0077): the invitation keys.
// API:
// - INVITATION_MAX_RESENDS (optional, 1-20, default 5; D11);
// - auth.userinfoUrl: <KEYCLOAK_ISSUER>/protocol/openid-connect/userinfo,
//   from the cell's config only (owner condition C3).
// Worker:
// - INVITE_LINK_BASE (required): an exact http(s) origin; production needs
//   https and a remote host;
// - MAILPIT_URL (optional, development only): production refuses it (D5);
// - EMAIL_FROM (optional, an address; default no-reply@bricx.invalid);
// - CELL_ID (required): the token's cell prefix (D1).
// The API never declares the worker's invitation keys.
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_INVITATION_MAX_RESENDS,
  MAX_INVITATION_MAX_RESENDS,
  apiKeys,
  loadApiConfig,
} from "../src/api.js";
import {
  DEFAULT_EMAIL_FROM,
  loadWorkerConfig,
  workerKeys,
} from "../src/worker.js";
import {
  devApiEnv,
  devWorkerEnv,
  prodApiEnv,
  prodWorkerEnv,
  without,
} from "./env.js";

function problemsOf(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems.map((p) => `${p.key}:${p.code}`);
  }
  return [];
}

describe("INVITATION_MAX_RESENDS (D11)", () => {
  it("unset: 5", () => {
    expect(DEFAULT_INVITATION_MAX_RESENDS).toBe(5);
    expect(loadApiConfig(devApiEnv).invitations).toEqual({ maxResends: 5 });
    expect(Object.isFrozen(loadApiConfig(devApiEnv).invitations)).toBe(true);
  });

  it.each([
    ["1", 1],
    ["5", 5],
    ["20", 20],
  ])("accepts %s", (raw, value) => {
    expect(
      loadApiConfig({ ...devApiEnv, INVITATION_MAX_RESENDS: raw }).invitations
        .maxResends,
    ).toBe(value);
    expect(MAX_INVITATION_MAX_RESENDS).toBe(20);
  });

  it.each([
    ["0", "too_small"],
    ["21", "too_big"],
    ["100", "invalid_format"],
    ["-1", "invalid_format"],
    ["2.5", "invalid_format"],
  ])("rejects %j (%s)", (raw, code) => {
    expect(
      problemsOf(() =>
        loadApiConfig({ ...devApiEnv, INVITATION_MAX_RESENDS: raw }),
      ),
    ).toEqual([`INVITATION_MAX_RESENDS:${code}`]);
  });

  it("is the API's only: the worker never reads it", () => {
    expect(apiKeys).toContain("INVITATION_MAX_RESENDS");
    expect(workerKeys).not.toContain("INVITATION_MAX_RESENDS");
  });
});

describe("auth.userinfoUrl (C3)", () => {
  it("is derived from KEYCLOAK_ISSUER, in development and production", () => {
    expect(loadApiConfig(devApiEnv).auth.userinfoUrl).toBe(
      "http://localhost:8080/realms/bricx/protocol/openid-connect/userinfo",
    );
    expect(loadApiConfig(prodApiEnv).auth.userinfoUrl).toBe(
      "https://auth.bricx.example/realms/bricx/protocol/openid-connect/userinfo",
    );
  });

  it("no key can point it elsewhere", () => {
    expect(apiKeys.filter((k) => /USERINFO/i.test(k))).toEqual([]);
  });
});

describe("the worker's invitation keys", () => {
  it("development: the values, frozen", () => {
    const config = loadWorkerConfig(devWorkerEnv);
    expect(config.cellId).toBe("af-south-1");
    expect(config.invitations).toEqual({ linkBase: "http://localhost:8081" });
    expect(config.email).toEqual({
      mailpitUrl: "http://127.0.0.1:8025",
      from: DEFAULT_EMAIL_FROM,
    });
    expect(DEFAULT_EMAIL_FROM).toBe("no-reply@bricx.invalid");
    expect(Object.isFrozen(config.email)).toBe(true);
  });

  it("INVITE_LINK_BASE is required and an exact origin", () => {
    expect(
      problemsOf(() =>
        loadWorkerConfig(without(devWorkerEnv, "INVITE_LINK_BASE")),
      ),
    ).toEqual(["INVITE_LINK_BASE:missing"]);
    for (const bad of [
      "localhost:8081",
      "ftp://app.example",
      "http://localhost:8081/",
      "http://localhost:8081/invite",
      "http://user:pw@localhost:8081",
      "http://localhost:8081?x=1",
      "http://localhost:8081#t",
    ]) {
      expect(
        problemsOf(() =>
          loadWorkerConfig({ ...devWorkerEnv, INVITE_LINK_BASE: bad }),
        ),
        bad,
      ).toEqual(["INVITE_LINK_BASE:invalid_format"]);
    }
  });

  it("MAILPIT_URL and EMAIL_FROM are optional", () => {
    const config = loadWorkerConfig(without(devWorkerEnv, "MAILPIT_URL"));
    expect(config.email).toEqual({
      mailpitUrl: undefined,
      from: DEFAULT_EMAIL_FROM,
    });
    expect(
      loadWorkerConfig({ ...devWorkerEnv, EMAIL_FROM: "invites@example.com" })
        .email.from,
    ).toBe("invites@example.com");
    expect(
      problemsOf(() =>
        loadWorkerConfig({ ...devWorkerEnv, EMAIL_FROM: "not an address" }),
      ),
    ).toEqual(["EMAIL_FROM:invalid_format"]);
    expect(
      problemsOf(() =>
        loadWorkerConfig({ ...devWorkerEnv, MAILPIT_URL: "smtp://x:1025" }),
      ),
    ).toEqual(["MAILPIT_URL:invalid_format"]);
  });

  it("production: valid without Mailpit", () => {
    expect(problemsOf(() => loadWorkerConfig(prodWorkerEnv))).toEqual([]);
    expect(loadWorkerConfig(prodWorkerEnv).email.mailpitUrl).toBeUndefined();
  });

  it("production refuses MAILPIT_URL, even a remote one (D5)", () => {
    expect(
      problemsOf(() =>
        loadWorkerConfig({
          ...prodWorkerEnv,
          MAILPIT_URL: "https://mail.internal.example",
        }),
      ),
    ).toEqual(["MAILPIT_URL:mailpit_in_production"]);
  });

  it("production: INVITE_LINK_BASE must be https on a remote host", () => {
    expect(
      problemsOf(() =>
        loadWorkerConfig({
          ...prodWorkerEnv,
          INVITE_LINK_BASE: "http://app.bricx.example",
        }),
      ),
    ).toEqual(["INVITE_LINK_BASE:https_required_in_production"]);
    expect(
      problemsOf(() =>
        loadWorkerConfig({
          ...prodWorkerEnv,
          INVITE_LINK_BASE: "https://localhost:8081",
        }),
      ),
    ).toEqual(["INVITE_LINK_BASE:local_host_in_production"]);
  });

  it("the API never declares the worker's invitation keys", () => {
    for (const key of ["INVITE_LINK_BASE", "MAILPIT_URL", "EMAIL_FROM"]) {
      expect(apiKeys).not.toContain(key);
      expect(workerKeys).toContain(key);
    }
  });
});
