// P6-02 (ADR 0072; D1, D2, D3, D13): the API's organisation keys.
// - CELL_ID (required): the cell this API serves, directory.cells' id
//   shape; every organisation it creates records it as data_region;
// - DIRECTORY_WRITER_DATABASE_URL (optional): directory_writer on
//   bricx_directory; absent, POST /v1/organizations answers 503; a
//   Secret; production refuses a local host;
// - ORGS_MAX_CREATED_PER_USER (optional, 1-1000, default 5): the
//   per-user create cap.
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_ORGS_MAX_CREATED_PER_USER,
  Secret,
  apiKeys,
  loadApiConfig,
} from "../src/api.js";
import { loadWorkerConfig, workerKeys } from "../src/worker.js";
import { devApiEnv, devWorkerEnv, prodApiEnv, without } from "./env.js";

const WRITER_URL =
  "postgres://directory_writer:test-password-123@127.0.0.1:5432/bricx_directory";
const PROD_WRITER_URL =
  "postgres://directory_writer:prod-password-789@directory.internal.example:5432/bricx_directory";

function problemsOf(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems.map((p) => `${p.key}:${p.code}`);
  }
  return [];
}

describe("CELL_ID (D2)", () => {
  // P6-06 (ADR 0077, D1): the worker reads it too, as the invitation
  // token's cell prefix; required by both, with the same rule.
  it("is declared by the API and the worker, and is required by both", () => {
    expect(apiKeys).toContain("CELL_ID");
    expect(workerKeys).toContain("CELL_ID");
    expect(
      problemsOf(() => loadApiConfig(without(devApiEnv, "CELL_ID"))),
    ).toEqual(["CELL_ID:missing"]);
    expect(
      problemsOf(() => loadWorkerConfig(without(devWorkerEnv, "CELL_ID"))),
    ).toEqual(["CELL_ID:missing"]);
    expect(
      problemsOf(() =>
        loadWorkerConfig({ ...devWorkerEnv, CELL_ID: "AF-SOUTH-1" }),
      ),
    ).toEqual(["CELL_ID:invalid_format"]);
  });

  it.each([["af-south-1"], ["eu-west-1"], ["us-east-2"], ["ap-southeast-10"]])(
    "accepts %s",
    (cell) => {
      expect(loadApiConfig({ ...devApiEnv, CELL_ID: cell }).cellId).toBe(cell);
    },
  );

  it.each([
    ["AF-south-1"],
    ["af_south_1"],
    ["af-south"],
    ["afsouth1"],
    ["a-south-1"],
    [" af-south-1"],
  ])("refuses %j", (cell) => {
    expect(
      problemsOf(() => loadApiConfig({ ...devApiEnv, CELL_ID: cell })),
    ).toEqual(["CELL_ID:invalid_format"]);
  });

  it("refuses more than 32 characters (the cells_id_shape CHECK)", () => {
    expect(
      problemsOf(() =>
        loadApiConfig({ ...devApiEnv, CELL_ID: `af-${"s".repeat(28)}-1` }),
      ),
    ).toEqual(["CELL_ID:too_big"]);
  });
});

describe("DIRECTORY_WRITER_DATABASE_URL (D3)", () => {
  it("is declared by the API only", () => {
    expect(apiKeys).toContain("DIRECTORY_WRITER_DATABASE_URL");
    expect(workerKeys).not.toContain("DIRECTORY_WRITER_DATABASE_URL");
  });

  it("absent: no writer (create answers 503)", () => {
    expect(loadApiConfig(devApiEnv).directoryWriter).toBeUndefined();
  });

  it("set: the directory_writer URL as a Secret, never serialised", () => {
    const config = loadApiConfig({
      ...devApiEnv,
      DIRECTORY_WRITER_DATABASE_URL: WRITER_URL,
    });
    expect(config.directoryWriter?.url).toBeInstanceOf(Secret);
    expect(config.directoryWriter?.url.reveal()).toBe(WRITER_URL);
    expect(JSON.stringify(config)).not.toContain("test-password-123");
  });

  it("must be a postgres URL", () => {
    expect(
      problemsOf(() =>
        loadApiConfig({
          ...devApiEnv,
          DIRECTORY_WRITER_DATABASE_URL: "https://directory.example",
        }),
      ),
    ).toEqual(["DIRECTORY_WRITER_DATABASE_URL:invalid_format"]);
  });

  it("production refuses a local host and accepts a remote one", () => {
    expect(
      problemsOf(() =>
        loadApiConfig({
          ...prodApiEnv,
          DIRECTORY_WRITER_DATABASE_URL: PROD_WRITER_URL,
        }),
      ),
    ).toEqual([]);
    expect(
      problemsOf(() =>
        loadApiConfig({
          ...prodApiEnv,
          DIRECTORY_WRITER_DATABASE_URL:
            "postgres://directory_writer:prod-password-789@127.0.0.1:5432/bricx_directory",
        }),
      ),
    ).toEqual(["DIRECTORY_WRITER_DATABASE_URL:local_host_in_production"]);
  });
});

describe("ORGS_MAX_CREATED_PER_USER (D1, D13)", () => {
  it("defaults to 5", () => {
    expect(DEFAULT_ORGS_MAX_CREATED_PER_USER).toBe(5);
    expect(loadApiConfig(devApiEnv).organizations.maxCreatedPerUser).toBe(5);
  });

  it.each([
    ["1", 1],
    ["5", 5],
    ["1000", 1000],
  ])("accepts %s", (raw, n) => {
    expect(
      loadApiConfig({ ...devApiEnv, ORGS_MAX_CREATED_PER_USER: raw })
        .organizations.maxCreatedPerUser,
    ).toBe(n);
  });

  it.each([["0"], ["1001"], ["-1"], ["1.5"], ["five"], ["00001"]])(
    "refuses %j",
    (raw) => {
      expect(
        problemsOf(() =>
          loadApiConfig({ ...devApiEnv, ORGS_MAX_CREATED_PER_USER: raw }),
        ),
      ).toHaveLength(1);
    },
  );
});
