// `audit:verify --org <uuid>` (P4-05, ADR 0055): walks one org's audit
// chain and reports the first break. Exit 0: intact (prints the head, so it
// can be recorded elsewhere); 1: broken at a seq, with the reason; 2:
// usage, config or database error (codes and key names only, never a URL
// or password). Reads DATABASE_URL like the API (bricx_app, under RLS, in
// one withTx() as that org). The user id is the nil UUID: verifying reads
// only, and org.audit's policies check the org alone (for architect
// review). Never reads an env file: the root audit:verify script hands
// node the dev one.
import { ConfigError, loadApiConfig } from "@bricx/config/api";
import { DatabaseUnavailableError, openDatabase } from "@bricx/db/database";
import { verifyAuditChain } from "./modules/audit/public-api.js";

const USAGE = "audit:verify: usage: audit:verify --org <uuid>\n";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL_USER = "00000000-0000-0000-0000-000000000000";

const fail = (message: string): void => {
  process.stderr.write(message);
  process.exitCode = 2;
};

async function main(): Promise<void> {
  const [flag, org, ...rest] = process.argv.slice(2);
  if (
    flag !== "--org" ||
    org === undefined ||
    !UUID.test(org) ||
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
      fail(`audit:verify: ${error.message}\n`);
      return;
    }
    throw error;
  }
  const database = openDatabase(config.database.url, { maxConnections: 1 });
  try {
    const result = await database.withTx(
      { orgId: org, userId: NIL_USER, projectIds: [] },
      (tx) => verifyAuditChain(tx),
    );
    if (result.status === "intact") {
      const head =
        result.head === null
          ? ""
          : `, head seq ${result.head.seq} hash ${result.head.hash}`;
      process.stdout.write(
        `audit:verify: org ${org}: intact, ${String(result.events)} events${head}\n`,
      );
    } else {
      process.stdout.write(
        `audit:verify: org ${org}: broken at seq ${result.seq} (id ${result.id}): ${result.reason}\n`,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) {
      fail("audit:verify: database_unavailable\n");
      return;
    }
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "unknown";
    fail(`audit:verify: database_error ${code}\n`);
  } finally {
    await database.close();
  }
}

await main();
