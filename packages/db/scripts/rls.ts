// `pnpm db:rls <bricx.table> <resource>` (P4-04, ADR 0054): prints the RLS
// SQL for a new tenant table, from @bricx/permissions' expressions. Append
// it to the migration that creates the table (the same transaction), then
// review it by hand (CLAUDE.md rule 12) and add the table to TENANT_TABLES.
// Runs on Node 24's type stripping: .ts imports only.
import process from "node:process";
import { enableTenantRls } from "../src/rls.ts";

const args = process.argv.slice(2);
const [table, resource] = args;
if (args.length !== 2 || table === undefined || resource === undefined) {
  process.stderr.write("usage: pnpm db:rls <bricx.table> <resource>\n");
  process.exit(2);
}
try {
  process.stdout.write(`${enableTenantRls(table, resource)}\n`);
} catch (error) {
  if (!(error instanceof Error)) throw error;
  process.stderr.write(`db:rls: ${error.message}\n`);
  process.exit(1);
}
