// The template_items table (P4-09, ADR 0059): a project-level tenant table
// for a project-level subject with created_by, built from the shared
// column helpers. The id comes from the device (CLAUDE.md rule 6); a name
// is unique per project, so a duplicate is SQLSTATE 23505 (409).
// new-module:template-only:start
// The template's copy of this file is the only table outside packages/db:
// drizzle-kit never reads it (it is not exported from tables.ts), and the
// template's integration test generates its migration. pnpm new-module
// writes a copy's to packages/db/src/schema/<module>.ts.
import { sql } from "drizzle-orm";
import { check, index, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import {
  bricx,
  createdAt,
  createdBy,
  id,
  orgId,
  updatedAt,
  version,
} from "@bricx/db/schema";
// new-module:template-only:end
// new-module:copy-only: import { sql } from "drizzle-orm";
// new-module:copy-only: import { check, index, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
// new-module:copy-only: import { createdAt, createdBy, id, orgId, updatedAt, version } from "./columns.js";
// new-module:copy-only: import { bricx } from "./namespace.js";

export const templateItems = bricx.table(
  "template_items",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id").notNull(),
    name: text("name").notNull(),
    createdBy: createdBy(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex("template_items_name").on(t.orgId, t.projectId, t.name),
    // The list's order: one project's rows by id (UUIDv7, so by time).
    index("template_items_project").on(t.orgId, t.projectId, t.id),
    check(
      "template_items_name_length",
      sql`char_length(${t.name}) BETWEEN 1 AND 200`,
    ),
    check("template_items_version", sql`${t.version} >= 1`),
  ],
);
