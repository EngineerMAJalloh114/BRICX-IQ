// The shared column helpers (P4-02): names, types, nullability and
// defaults as Drizzle will emit them, read back through getTableConfig.
import { SQL, is } from "drizzle-orm";
import { PgDialect, PgSchema, getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  createdAt,
  createdBy,
  deletedAt,
  id,
  orgId,
  updatedAt,
  version,
} from "../src/schema/columns.js";
import { bricx } from "../src/schema/namespace.js";
import * as tables from "../src/schema/tables.js";

const sample = bricx.table("sample", {
  id: id(),
  orgId: orgId(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  createdBy: createdBy(),
  version: version(),
  deletedAt: deletedAt(),
});

function column(name: string) {
  const found = getTableConfig(sample).columns.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no column ${name}`);
  return {
    type: found.getSQLType(),
    notNull: found.notNull,
    primary: found.primary,
    hasDefault: found.hasDefault,
  };
}

/** The SQL text of a column's default, or undefined. */
function defaultSql(name: string): string | undefined {
  const found = getTableConfig(sample).columns.find((c) => c.name === name);
  const value: unknown = found?.default;
  if (value === undefined) return undefined;
  if (is(value, SQL)) return new PgDialect().sqlToQuery(value).sql;
  return JSON.stringify(value);
}

describe("bricx schema", () => {
  it("tables live in schema bricx", () => {
    expect(bricx.schemaName).toBe("bricx");
    expect(getTableConfig(sample).schema).toBe("bricx");
  });

  it("drizzle-kit's entry exports no PgSchema, so no migration creates the schema", () => {
    // 01-bootstrap.sh creates bricx owned by bricx_owner, who has no CREATE
    // on the database: an exported pgSchema() would make drizzle-kit emit
    // CREATE SCHEMA, which fails.
    for (const value of Object.values(tables)) {
      expect(is(value, PgSchema)).toBe(false);
    }
  });
});

describe("column helpers", () => {
  it("columns are snake_case in declaration order", () => {
    expect(getTableConfig(sample).columns.map((c) => c.name)).toEqual([
      "id",
      "org_id",
      "created_at",
      "updated_at",
      "created_by",
      "version",
      "deleted_at",
    ]);
  });

  it("id is a uuid primary key defaulting to uuidv7()", () => {
    expect(column("id")).toEqual({
      type: "uuid",
      notNull: true,
      primary: true,
      hasDefault: true,
    });
    expect(defaultSql("id")).toBe("uuidv7()");
  });

  it("org_id and created_by are required uuids with no default", () => {
    for (const name of ["org_id", "created_by"]) {
      expect(column(name)).toEqual({
        type: "uuid",
        notNull: true,
        primary: false,
        hasDefault: false,
      });
    }
  });

  it("created_at and updated_at are required timestamptz defaulting to now()", () => {
    for (const name of ["created_at", "updated_at"]) {
      expect(column(name)).toEqual({
        type: "timestamp with time zone",
        notNull: true,
        primary: false,
        hasDefault: true,
      });
      expect(defaultSql(name)).toBe("now()");
    }
  });

  it("version is a required integer starting at 1", () => {
    expect(column("version")).toEqual({
      type: "integer",
      notNull: true,
      primary: false,
      hasDefault: true,
    });
    expect(defaultSql("version")).toBe("1");
  });

  it("deleted_at is a nullable timestamptz with no default", () => {
    expect(column("deleted_at")).toEqual({
      type: "timestamp with time zone",
      notNull: false,
      primary: false,
      hasDefault: false,
    });
  });

  it("each call returns a fresh builder", () => {
    expect(id()).not.toBe(id());
    expect(createdAt()).not.toBe(createdAt());
  });
});
