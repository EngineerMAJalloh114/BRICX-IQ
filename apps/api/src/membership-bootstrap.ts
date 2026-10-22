// `membership:bootstrap --org <uuid> --user <users.id>` (P5-05, ADR 0066;
// plan 3.4): an organisation's first owner, until P6-02 makes
// organisations. Exit 0: done (prints the ids); 1: refused (org_not_empty,
// user_missing); 2: usage, config or database error (codes and key names
// only, never a URL or password). Reads DATABASE_URL like the API
// (bricx_app, under RLS, in one withTx() as that org and that user, so
// the audit actor is the new owner). Never reads an env file: the root
// script hands node the dev one.
import { ConfigError, loadApiConfig } from "@bricx/config/api";
import { DatabaseUnavailableError, openDatabase } from "@bricx/db/database";
import { createUuidV7Generator } from "@bricx/ids/uuid-v7";
import { systemClock } from "./common/clock.js";
import { AuditService } from "./modules/audit/public-api.js";
import {
  BootstrapError,
  MembershipsRepository,
  bootstrapOrganization,
} from "./modules/memberships/public-api.js";
import { OutboxService } from "./modules/outbox/public-api.js";
import { RolesRepository } from "./modules/roles/public-api.js";

const USAGE =
  "membership:bootstrap: usage: membership:bootstrap --org <uuid> --user <users.id>\n";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const fail = (message: string): void => {
  process.stderr.write(message);
  process.exitCode = 2;
};

async function main(): Promise<void> {
  const [orgFlag, org, userFlag, user, ...rest] = process.argv.slice(2);
  if (
    orgFlag !== "--org" ||
    org === undefined ||
    !UUID.test(org) ||
    userFlag !== "--user" ||
    user === undefined ||
    !UUID.test(user) ||
    rest.length > 0
  ) {
    fail(USAGE);
    return;
  }
  let config;
  try {
    config = loadApiConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      fail(`membership:bootstrap: ${error.message}\n`);
      return;
    }
    throw error;
  }
  const database = openDatabase(config.database.url, { maxConnections: 1 });
  const clock = systemClock;
  const deps = {
    roles: new RolesRepository(),
    members: new MembershipsRepository(),
    audit: new AuditService(clock),
    outbox: new OutboxService(clock),
    ids: createUuidV7Generator({ clock }),
  };
  try {
    const result = await database.withTx(
      { orgId: org, userId: user, projectIds: [] },
      (tx) =>
        bootstrapOrganization(tx, deps, {
          orgId: org,
          userId: user,
          now: new Date(clock.now()).toISOString(),
        }),
    );
    process.stdout.write(
      `membership:bootstrap: org ${org}: owner ${user}, membership ${result.membershipId}, ${String(result.roles)} roles\n`,
    );
  } catch (error) {
    if (error instanceof BootstrapError) {
      process.stdout.write(
        `membership:bootstrap: org ${org}: ${error.reason}\n`,
      );
      process.exitCode = 1;
      return;
    }
    if (error instanceof DatabaseUnavailableError) {
      fail("membership:bootstrap: database_unavailable\n");
      return;
    }
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "unknown";
    fail(`membership:bootstrap: database_error ${code}\n`);
  } finally {
    await database.close();
  }
}

await main();
