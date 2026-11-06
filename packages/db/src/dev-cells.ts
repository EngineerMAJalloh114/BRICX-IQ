// The local stack's directory cells (P6-02, ADR 0072; owner ruling R2):
// `pnpm db:migrate` runs ensureDevCells() right after the directory journal,
// as directory_owner, so creating an organisation locally never fails with
// unknown_cell. Both launch cells (ADR 0071) point at the one local stack.
// - Only for NODE_ENV=development and a directory URL whose host is local
//   (devCellsAllowed); anything else is skipped, never attempted.
// - Idempotent: INSERT ... ON CONFLICT DO NOTHING, then every cell row is
//   read back; a row whose URLs differ from these is DevCellsError
//   (cell_drift, naming the cell id only) and is never overwritten.
// The owner's other rows (organisations, domains) are not touched.
import { sql } from "drizzle-orm";
import {
  type DatabaseOptions,
  type SecretUrl,
  openDirectoryDatabase,
} from "./database.js";

/** One directory.cells row. */
export interface DevCell {
  readonly id: string;
  readonly apiBaseUrl: string;
  readonly keycloakUrl: string;
}

/**
 * The launch cells (ADR 0071), both served by the local stack: the API on
 * API_PORT 4000 and Keycloak's realm (KEYCLOAK_ISSUER in .env.example).
 * (architect-reviewed 2026-11-06)
 */
export const DEV_CELLS: readonly DevCell[] = Object.freeze([
  Object.freeze({
    id: "af-south-1",
    apiBaseUrl: "http://localhost:4000",
    keycloakUrl: "http://localhost:8080/realms/bricx",
  }),
  Object.freeze({
    id: "eu-west-1",
    apiBaseUrl: "http://localhost:4000",
    keycloakUrl: "http://localhost:8080/realms/bricx",
  }),
]);

/** The hosts a development directory URL may name. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

/**
 * Whether db:migrate inserts the dev cells: NODE_ENV is development and
 * the directory URL's host is local. A malformed URL is false.
 */
export function devCellsAllowed(nodeEnv: unknown, url: SecretUrl): boolean {
  if (nodeEnv !== "development") return false;
  const text = url.reveal();
  if (!URL.canParse(text)) return false;
  // A postgres: URL is not a special scheme, so its host keeps its case.
  return LOCAL_HOSTS.has(new URL(text).hostname.toLowerCase());
}

export type DevCellsErrorCode = "cell_drift";

/** ensureDevCells() refused: a code and the cell id, never a URL. */
export class DevCellsError extends Error {
  readonly code: DevCellsErrorCode;
  readonly cell: string;

  constructor(code: DevCellsErrorCode, cell: string) {
    super(`dev cells: ${code} (${cell})`);
    this.code = code;
    this.cell = cell;
  }
}
Object.defineProperty(DevCellsError.prototype, "name", {
  value: "DevCellsError",
});

/** The directory_owner role ensureDevCells() runs as. */
const OWNER_ROLE = "directory_owner";

class WrongRoleError extends Error {
  constructor() {
    super("dev cells: wrong role");
  }
}

/**
 * Inserts DEV_CELLS that are missing, as directory_owner, in one
 * transaction, and returns the ids it inserted. A cell row with other
 * URLs is DevCellsError and nothing is written.
 */
export async function ensureDevCells(
  url: SecretUrl,
  options: DatabaseOptions = {},
): Promise<{ readonly inserted: readonly string[] }> {
  const db = openDirectoryDatabase(
    url,
    {
      role: OWNER_ROLE,
      readOnly: false,
      onWrongRole: () => new WrongRoleError(),
    },
    { maxConnections: 1, ...options },
  );
  try {
    return await db.transaction(async (tx) => {
      const inserted: string[] = [];
      for (const cell of DEV_CELLS) {
        const result = await tx.execute<{ id: string }>(
          sql`INSERT INTO directory.cells (id, api_base_url, keycloak_url)
              VALUES (${cell.id}, ${cell.apiBaseUrl}, ${cell.keycloakUrl})
              ON CONFLICT (id) DO NOTHING
              RETURNING id`,
        );
        if (result.rows.length > 0) inserted.push(cell.id);
      }
      for (const cell of DEV_CELLS) {
        const found = await tx.execute<{
          api_base_url: string;
          keycloak_url: string;
        }>(
          sql`SELECT api_base_url, keycloak_url FROM directory.cells WHERE id = ${cell.id}`,
        );
        const row = found.rows[0];
        if (
          row?.api_base_url !== cell.apiBaseUrl ||
          row.keycloak_url !== cell.keycloakUrl
        ) {
          throw new DevCellsError("cell_drift", cell.id);
        }
      }
      return { inserted };
    });
  } finally {
    await db.close();
  }
}
