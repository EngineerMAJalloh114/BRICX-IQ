// The application schema (ADR 0035): created by 01-bootstrap.sh, owned by
// bricx_owner. Deliberately NOT exported from tables.ts, drizzle-kit's
// entry: an exported pgSchema() makes drizzle-kit emit CREATE SCHEMA,
// which bricx_owner may not run (no CREATE on the database).
import { pgSchema } from "drizzle-orm/pg-core";

export const bricx = pgSchema("bricx");
