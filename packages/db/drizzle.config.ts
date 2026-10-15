// drizzle-kit (P4-02, ADR 0052): `pnpm db:generate` writes migrations from
// the tables in src/schema/tables.ts. Offline: no database URL here. The
// migrator in src/migrate.ts applies them as bricx_owner.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/tables.ts",
  out: "./migrations",
  schemaFilter: ["bricx"],
  strict: true,
  verbose: true,
});
