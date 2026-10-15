// Migrate entry point (P4-02, ADR 0052), run by `pnpm db:migrate`. Config
// is validated first (keys and codes only on failure), then the migrator
// is imported and applies every pending migration as bricx_owner. Never
// reads an env file: the root db:migrate script hands node the dev one,
// and a deploy job gets its environment from the platform.
import { ConfigError, loadMigrateConfig } from "@bricx/config/migrate";

let config;
try {
  config = loadMigrateConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

const { MigrationError, migrate } = await import("@bricx/db/migrate");
try {
  const result = await migrate(config.migrationDatabase.url);
  process.stdout.write(
    result.applied.length === 0
      ? "db:migrate: 0 applied\n"
      : `db:migrate: applied ${String(result.applied.length)} (${result.applied.join(", ")})\n`,
  );
} catch (error) {
  if (error instanceof MigrationError) {
    process.stderr.write(`db:migrate: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
