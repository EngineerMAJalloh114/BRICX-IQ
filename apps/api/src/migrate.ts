// Migrate entry point (P4-02, ADR 0052), run by `pnpm db:migrate`. Config
// is validated first (keys and codes only on failure), then the migrator
// is imported and applies every pending migration as bricx_owner. Never
// reads an env file: the root db:migrate script hands node the dev one,
// and a deploy job gets its environment from the platform. P6-01 (ADR
// 0071): with DIRECTORY_MIGRATION_DATABASE_URL set, the directory journal
// runs next, as directory_owner on bricx_directory.
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

const { MigrationError, migrate, migrateDirectory } =
  await import("@bricx/db/migrate");

const report = (label: string, applied: readonly string[]) =>
  applied.length === 0
    ? `${label}: 0 applied\n`
    : `${label}: applied ${String(applied.length)} (${applied.join(", ")})\n`;

let label = "db:migrate";
try {
  const result = await migrate(config.migrationDatabase.url);
  process.stdout.write(report(label, result.applied));
  const directoryUrl = config.directoryMigrationDatabase?.url;
  if (directoryUrl !== undefined) {
    label = "db:migrate directory";
    const directory = await migrateDirectory(directoryUrl);
    process.stdout.write(report(label, directory.applied));
  }
} catch (error) {
  if (error instanceof MigrationError) {
    process.stderr.write(`${label}: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
