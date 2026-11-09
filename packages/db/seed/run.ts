// `pnpm db:seed` (P6-05b, ADR 0076; binding decisions C1, E1, I1; owner
// conditions 3, 5 and 6): the root script runs this file with tsx, which
// loads the repository's .env first (a missing .env stops Node before this
// file runs, naming the file; the root package.json is the dev entry point
// that loads it, ADR 0039). Loads the seed config (NODE_ENV and DATABASE_URL only;
// production, a non-local host and a user other than bricx_app are
// refused), opens the app's pool and writes the dataset through withTx().
// On success it prints one line, the same on every run: the dataset's row
// count per table and "no drift" (counts only, condition 5). On a refusal
// or drift it prints the error's own message (keys, codes, table and id,
// never a value) to stderr and exits 1; anything else prints its name only.
import { ConfigError, loadSeedConfig } from "@bricx/config/seed";
import { openDatabase } from "../src/database.js";
import { buildDataset } from "./dataset.js";
import { seedId } from "./ids.js";
import { SEED_TABLES, SeedDriftError, SeedRoleError, runSeed } from "./seed.js";

async function main(): Promise<number> {
  let config;
  try {
    config = loadSeedConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
  const db = openDatabase(config.database.url, { maxConnections: 1 });
  try {
    const result = await runSeed(db, buildDataset(seedId));
    const counts = SEED_TABLES.map(
      (table) => `${table} ${String(result.tables[table])}`,
    ).join(", ");
    process.stdout.write(`seed: ${counts}; no drift\n`);
    return 0;
  } catch (error) {
    if (error instanceof SeedDriftError || error instanceof SeedRoleError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    const name = error instanceof Error ? error.name : "unknown error";
    process.stderr.write(`seed failed: ${name}\n`);
    return 1;
  } finally {
    await db.close();
  }
}

process.exitCode = await main();
