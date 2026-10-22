// P4-03: the transaction context is validated and copied before any
// connection is used. Errors name the field only, never the value.
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  InvalidTxContextError,
  MAX_PROJECT_IDS,
  NestedTransactionError,
  contextSettings,
  contextStatement,
  validateTxContext,
} from "../src/tx.js";

const ORG = "0199e1a0-0000-7000-8000-000000000001";
const USER = "0199e1a0-0000-7000-8000-000000000002";
const P1 = "0199e1a0-0000-7000-8000-000000000003";
const P2 = "0199e1a0-0000-7000-8000-000000000004";
const V4 = "3f2b8c1e-9a4d-4c2b-8e1f-6d5a4b3c2d1e";

function fieldOf(input: unknown): string {
  try {
    validateTxContext(input);
  } catch (error) {
    if (error instanceof InvalidTxContextError) return error.field;
    throw error;
  }
  throw new Error("expected InvalidTxContextError");
}

describe("validateTxContext", () => {
  it("returns a frozen copy with a frozen project list", () => {
    const projectIds = [P1, P2];
    const input = { orgId: ORG, userId: USER, projectIds };
    const ctx = validateTxContext(input);
    expect(ctx).toEqual({ orgId: ORG, userId: USER, projectIds: [P1, P2] });
    expect(ctx).not.toBe(input);
    expect(ctx.projectIds).not.toBe(projectIds);
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.projectIds)).toBe(true);
    projectIds.push(V4);
    input.orgId = USER;
    expect(ctx).toEqual({ orgId: ORG, userId: USER, projectIds: [P1, P2] });
  });

  it("accepts any canonical UUID version (Keycloak user ids are v4) and no projects", () => {
    expect(
      validateTxContext({ orgId: ORG, userId: V4, projectIds: [] }),
    ).toEqual({ orgId: ORG, userId: V4, projectIds: [] });
  });

  // P5-05 (owner condition 2, ADR 0066): every project of the org, only
  // through the distinct typed option, never as an id in projectIds.
  it("allProjects: true with no project ids is copied as the distinct option", () => {
    const ctx = validateTxContext({
      orgId: ORG,
      userId: USER,
      projectIds: [],
      allProjects: true,
    });
    expect(ctx).toEqual({
      orgId: ORG,
      userId: USER,
      projectIds: [],
      allProjects: true,
    });
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it("allProjects: false or absent leaves the copy without the key", () => {
    expect(
      Object.keys(
        validateTxContext({
          orgId: ORG,
          userId: USER,
          projectIds: [P1],
          allProjects: false,
        }),
      ).sort(),
    ).toEqual(["orgId", "projectIds", "userId"]);
  });

  it.each([
    [
      "allProjects with project ids",
      { orgId: ORG, userId: USER, projectIds: [P1], allProjects: true },
      "projectIds",
    ],
    [
      "allProjects not a boolean",
      { orgId: ORG, userId: USER, projectIds: [], allProjects: "yes" },
      "allProjects",
    ],
    [
      "allProjects as 1",
      { orgId: ORG, userId: USER, projectIds: [], allProjects: 1 },
      "allProjects",
    ],
    [
      "'*' as a project id",
      { orgId: ORG, userId: USER, projectIds: ["*"] },
      "projectIds",
    ],
    [
      "'*' as the project list",
      { orgId: ORG, userId: USER, projectIds: "*" },
      "projectIds",
    ],
    [
      "'{*}' as a project id",
      { orgId: ORG, userId: USER, projectIds: ["{*}"] },
      "projectIds",
    ],
  ])("refuses %s (condition 2)", (_name, input, field) => {
    expect(fieldOf(input)).toBe(field);
  });

  it("ignores extra keys", () => {
    const ctx = validateTxContext({
      orgId: ORG,
      userId: USER,
      projectIds: [],
      roles: ["owner"],
    });
    expect(Object.keys(ctx).sort()).toEqual(["orgId", "projectIds", "userId"]);
  });

  it.each([
    ["not an object", null, "context"],
    ["a string", "org", "context"],
    ["an array", [ORG], "context"],
    ["missing orgId", { userId: USER, projectIds: [] }, "orgId"],
    ["orgId not a string", { orgId: 1, userId: USER, projectIds: [] }, "orgId"],
    [
      "orgId upper case",
      { orgId: ORG.toUpperCase(), userId: USER, projectIds: [] },
      "orgId",
    ],
    [
      "orgId braced",
      { orgId: `{${ORG}}`, userId: USER, projectIds: [] },
      "orgId",
    ],
    [
      "orgId with SQL",
      { orgId: `${ORG}'; DROP TABLE x; --`, userId: USER, projectIds: [] },
      "orgId",
    ],
    ["orgId empty", { orgId: "", userId: USER, projectIds: [] }, "orgId"],
    ["missing userId", { orgId: ORG, projectIds: [] }, "userId"],
    [
      "userId not a UUID",
      { orgId: ORG, userId: "admin", projectIds: [] },
      "userId",
    ],
    ["missing projectIds", { orgId: ORG, userId: USER }, "projectIds"],
    [
      "projectIds not an array",
      { orgId: ORG, userId: USER, projectIds: P1 },
      "projectIds",
    ],
    [
      "a project id not a UUID",
      { orgId: ORG, userId: USER, projectIds: [P1, "x"] },
      "projectIds",
    ],
    [
      "a project id not a string",
      { orgId: ORG, userId: USER, projectIds: [1] },
      "projectIds",
    ],
    [
      "a duplicate project id",
      { orgId: ORG, userId: USER, projectIds: [P1, P1] },
      "projectIds",
    ],
  ])("refuses %s", (_name, input, field) => {
    expect(fieldOf(input)).toBe(field);
  });

  it(`refuses more than ${String(MAX_PROJECT_IDS)} project ids before reading them`, () => {
    const ids = Array.from(
      { length: MAX_PROJECT_IDS },
      (_, i) => `0199e1a0-0000-7000-8000-${i.toString(16).padStart(12, "0")}`,
    );
    expect(
      validateTxContext({ orgId: ORG, userId: USER, projectIds: ids })
        .projectIds,
    ).toHaveLength(MAX_PROJECT_IDS);
    // Not read: a sparse array of this length would fail element checks.
    const tooMany: unknown[] = [];
    tooMany.length = MAX_PROJECT_IDS + 1;
    expect(fieldOf({ orgId: ORG, userId: USER, projectIds: tooMany })).toBe(
      "projectIds",
    );
  });

  it("the error names the field and never the value", () => {
    const secret = `${ORG}-secret-value`;
    let error: unknown;
    try {
      validateTxContext({ orgId: secret, userId: USER, projectIds: [] });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(InvalidTxContextError);
    expect(error).toMatchObject({
      name: "InvalidTxContextError",
      message: "invalid transaction context: orgId",
      field: "orgId",
    });
    expect(JSON.stringify(error)).not.toContain("secret");
    expect((error as Error).cause).toBeUndefined();
  });
});

describe("contextSettings", () => {
  it("is the three app.* settings plus the statement timeout, project ids as a Postgres array literal", () => {
    const ctx = validateTxContext({
      orgId: ORG,
      userId: USER,
      projectIds: [P1, P2],
    });
    expect(contextSettings(ctx, 30_000)).toEqual([
      ["app.org_id", ORG],
      ["app.user_id", USER],
      ["app.project_ids", `{${P1},${P2}}`],
      ["statement_timeout", "30000"],
    ]);
    expect(
      contextSettings(
        validateTxContext({ orgId: ORG, userId: USER, projectIds: [] }),
        250,
      ),
    ).toEqual([
      ["app.org_id", ORG],
      ["app.user_id", USER],
      ["app.project_ids", "{}"],
      ["statement_timeout", "250"],
    ]);
  });
});

describe("contextSettings with allProjects (P5-05, condition 2)", () => {
  it("sets app.project_ids to '*' only from the typed option", () => {
    const ctx = validateTxContext({
      orgId: ORG,
      userId: USER,
      projectIds: [],
      allProjects: true,
    });
    expect(contextSettings(ctx, 30_000)).toEqual([
      ["app.org_id", ORG],
      ["app.user_id", USER],
      ["app.project_ids", "*"],
      ["statement_timeout", "30000"],
    ]);
    const query = new PgDialect().sqlToQuery(contextStatement(ctx, 30_000));
    expect(query.params[5]).toBe("*");
  });
});

describe("contextStatement", () => {
  it("is one SELECT of four transaction-local set_config calls, every value a bind parameter", () => {
    const ctx = validateTxContext({
      orgId: ORG,
      userId: USER,
      projectIds: [P1],
    });
    const query = new PgDialect().sqlToQuery(contextStatement(ctx, 1234));
    expect(query.sql.replace(/\s+/g, " ")).toBe(
      "SELECT set_config($1, $2, true), set_config($3, $4, true), set_config($5, $6, true), set_config($7, $8, true)",
    );
    expect(query.params).toEqual([
      "app.org_id",
      ORG,
      "app.user_id",
      USER,
      "app.project_ids",
      `{${P1}}`,
      "statement_timeout",
      "1234",
    ]);
  });
});

describe("NestedTransactionError", () => {
  it("has a fixed message", () => {
    expect(new NestedTransactionError()).toMatchObject({
      name: "NestedTransactionError",
      message: "withTx() called inside another withTx()",
    });
  });
});
