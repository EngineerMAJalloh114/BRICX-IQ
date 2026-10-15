// Shared column helpers (P4-02, ADR 0052). Each call returns a fresh
// builder. Timestamps are timestamptz (UTC in storage, CLAUDE.md rule 7)
// read as ISO strings, not Date objects (for architect review).
import { sql } from "drizzle-orm";
import { integer, timestamp, uuid } from "drizzle-orm/pg-core";

/** Primary key; the server fallback is Postgres 18's uuidv7(). Syncable
 * rows get their id on the device (CLAUDE.md rule 6). */
export const id = () =>
  uuid("id")
    .primaryKey()
    .default(sql`uuidv7()`);

/** The tenant (CLAUDE.md rule 3). */
export const orgId = () => uuid("org_id").notNull();

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });

export const createdAt = () => timestamptz("created_at").notNull().defaultNow();
export const updatedAt = () => timestamptz("updated_at").notNull().defaultNow();

/** The user who created the row. */
export const createdBy = () => uuid("created_by").notNull();

/** Optimistic-concurrency version, starting at 1. */
export const version = () => integer("version").notNull().default(1);

/** Soft delete: null while the row is live. */
export const deletedAt = () => timestamptz("deleted_at");
