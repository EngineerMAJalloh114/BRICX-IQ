// The global directory's runtime handles (P6-01, ADR 0071; owner
// conditions C1, C2 and C3). Two handles, each bound to one role and
// checked at the start of every transaction (openDirectoryDatabase):
// - openDirectoryReader(): directory_reader, READ ONLY transactions;
//   resolve() answers which cell serves an organisation slug or a verified
//   e-mail domain, and never an organisation id;
// - openDirectoryWriter(): directory_writer; registerOrganization() is a
//   reservation of (org_id, slug, cell): `reserved` once, `existing` for
//   the same triple, a typed DirectoryRegistrationError otherwise. P6-02
//   calls it synchronously before the cell commits the organisation (a
//   recorded exception to CLAUDE.md rule 5, ADR 0071).
// There is no function that writes a domain (C3): domain rows need DNS
// verification first (P6-02, P6-06). Inputs are bounded and checked
// against the same shapes as the table CHECKs before any query; errors
// carry a code, never a value.
import { sql } from "drizzle-orm";
import {
  DatabaseUnavailableError,
  type DatabaseOptions,
  type DirectoryDatabase,
  type SecretUrl,
  openDirectoryDatabase,
  sqlstateOf,
} from "./database.js";

/** The role the public resolve route and the global deployment use. */
export const DIRECTORY_READER_ROLE = "directory_reader";
/** The role registerOrganization() uses (P6-02). */
export const DIRECTORY_WRITER_ROLE = "directory_writer";
/** Longest organisation slug (directory.org_directory's CHECK). */
export const ORG_SLUG_MAX = 63;
/** Longest e-mail domain (directory.org_email_domains's CHECK). */
export const EMAIL_DOMAIN_MAX = 253;

// The table CHECKs, mirrored (directory-migrations/0000_directory.sql).
const ORG_SLUG = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const EMAIL_DOMAIN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CELL_ID = /^[a-z]{2}(?:-[a-z]+)+-[0-9]+$/;
const CELL_ID_MAX = 32;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An organisation slug as the directory stores it (length checked first). */
export const isOrgSlug = (value: string): boolean =>
  value.length <= ORG_SLUG_MAX && ORG_SLUG.test(value);

/** A lower-case ASCII e-mail domain as the directory stores it. */
export const isEmailDomain = (value: string): boolean =>
  value.length <= EMAIL_DOMAIN_MAX && EMAIL_DOMAIN.test(value);

const isCellId = (value: string): boolean =>
  value.length <= CELL_ID_MAX && CELL_ID.test(value);

export type DirectoryRegistrationCode =
  /** A malformed org id, slug or cell id (no query ran). */
  | "invalid_input"
  /** Another organisation holds the slug. */
  | "slug_taken"
  /** This organisation is registered with another slug or cell. */
  | "org_registered_differently"
  /** No such cell. */
  | "unknown_cell";

/** registerOrganization() refused: a code, never a value. */
export class DirectoryRegistrationError extends Error {
  readonly code: DirectoryRegistrationCode;

  constructor(code: DirectoryRegistrationCode) {
    super(`directory registration refused: ${code}`);
    this.code = code;
  }
}
Object.defineProperty(DirectoryRegistrationError.prototype, "name", {
  value: "DirectoryRegistrationError",
});

/** A directory handle's URL is not its role (the owner's, or the other handle's). */
export class DirectoryRoleError extends Error {
  constructor() {
    super("directory transaction: wrong role");
  }
}
Object.defineProperty(DirectoryRoleError.prototype, "name", {
  value: "DirectoryRoleError",
});

/** Which cell serves an organisation, and where its API and Keycloak are. */
export interface CellRoute {
  readonly cell: string;
  readonly apiBaseUrl: string;
  readonly keycloakUrl: string;
}

/** Exactly one key: a slug, or the domain of an e-mail address. */
export type DirectoryLookup =
  { readonly orgSlug: string } | { readonly emailDomain: string };

export interface Registration {
  readonly orgId: string;
  readonly slug: string;
  readonly cellId: string;
}

export interface DirectoryReader {
  /** Resolves when Postgres answers within the bound. */
  ping(): Promise<void>;
  /**
   * The cell serving `lookup`, or undefined when no organisation (or no
   * verified domain) matches. A malformed or oversized key is undefined
   * without a query.
   */
  resolve(lookup: DirectoryLookup): Promise<CellRoute | undefined>;
  close(): Promise<void>;
}

export interface DirectoryWriter {
  ping(): Promise<void>;
  /**
   * Reserves `slug` in `cellId` for `orgId`: `reserved` the first time,
   * `existing` for the same triple (a retry reuses the reservation);
   * otherwise DirectoryRegistrationError (`invalid_input`, `slug_taken`,
   * `org_registered_differently`, `unknown_cell`).
   */
  registerOrganization(input: Registration): Promise<"reserved" | "existing">;
  close(): Promise<void>;
}

interface RouteRow extends Record<string, unknown> {
  cell: string;
  api_base_url: string;
  keycloak_url: string;
}

const routeOf = (row: RouteRow | undefined): CellRoute | undefined =>
  row === undefined
    ? undefined
    : {
        cell: row.cell,
        apiBaseUrl: row.api_base_url,
        keycloakUrl: row.keycloak_url,
      };

/** The directory_reader handle (DIRECTORY_DATABASE_URL). */
export function openDirectoryReader(
  url: SecretUrl,
  options: DatabaseOptions = {},
): DirectoryReader {
  const db = openDirectoryDatabase(
    url,
    {
      role: DIRECTORY_READER_ROLE,
      readOnly: true,
      onWrongRole: () => new DirectoryRoleError(),
    },
    options,
  );
  return {
    ping: () => db.ping(),
    async resolve(lookup) {
      if ("orgSlug" in lookup) {
        const slug = lookup.orgSlug;
        if (typeof slug !== "string" || !isOrgSlug(slug)) return undefined;
        return db.transaction(async (tx) => {
          const found = await tx.execute<RouteRow>(
            sql`SELECT c.id AS cell, c.api_base_url, c.keycloak_url
                FROM directory.org_directory o
                JOIN directory.cells c ON c.id = o.cell_id
                WHERE o.org_slug = ${slug}`,
          );
          return routeOf(found.rows[0]);
        });
      }
      const domain = lookup.emailDomain;
      if (typeof domain !== "string" || !isEmailDomain(domain)) {
        return undefined;
      }
      return db.transaction(async (tx) => {
        const found = await tx.execute<RouteRow>(
          sql`SELECT c.id AS cell, c.api_base_url, c.keycloak_url
              FROM directory.org_email_domains d
              JOIN directory.org_directory o ON o.org_id = d.org_id
              JOIN directory.cells c ON c.id = o.cell_id
              WHERE d.domain = ${domain}`,
        );
        return routeOf(found.rows[0]);
      });
    },
    close: () => db.close(),
  };
}

interface HolderRow extends Record<string, unknown> {
  org_id: string;
  org_slug: string;
  cell_id: string;
}

/** How often a reservation is retried when its conflict vanished meanwhile. */
const RESERVE_ATTEMPTS = 3;

async function reserve(
  db: DirectoryDatabase,
  { orgId, slug, cellId }: Registration,
): Promise<"reserved" | "existing" | undefined> {
  return db.transaction(async (tx) => {
    let inserted: { rows: unknown[] };
    try {
      inserted = await tx.execute(
        sql`INSERT INTO directory.org_directory (org_id, org_slug, cell_id)
            VALUES (${orgId}::uuid, ${slug}, ${cellId})
            ON CONFLICT DO NOTHING
            RETURNING org_id`,
      );
    } catch (error) {
      if (sqlstateOf(error) === "23503") {
        throw new DirectoryRegistrationError("unknown_cell");
      }
      throw error;
    }
    if (inserted.rows.length === 1) return "reserved";
    // The insert met a committed row holding this org id or this slug
    // (ON CONFLICT waits for a concurrent insert to commit or roll back).
    const holders = await tx.execute<HolderRow>(
      sql`SELECT org_id::text AS org_id, org_slug, cell_id
          FROM directory.org_directory
          WHERE org_id = ${orgId}::uuid OR org_slug = ${slug}`,
    );
    const own = holders.rows.find((row) => row.org_id === orgId);
    if (own !== undefined) {
      if (own.org_slug === slug && own.cell_id === cellId) return "existing";
      throw new DirectoryRegistrationError("org_registered_differently");
    }
    if (holders.rows.some((row) => row.org_slug === slug)) {
      throw new DirectoryRegistrationError("slug_taken");
    }
    // The conflicting row is gone (released between the two statements).
    return undefined;
  });
}

/** The directory_writer handle (P6-02's registration only). */
export function openDirectoryWriter(
  url: SecretUrl,
  options: DatabaseOptions = {},
): DirectoryWriter {
  const db = openDirectoryDatabase(
    url,
    {
      role: DIRECTORY_WRITER_ROLE,
      readOnly: false,
      onWrongRole: () => new DirectoryRoleError(),
    },
    options,
  );
  return {
    ping: () => db.ping(),
    async registerOrganization(input) {
      const { orgId, slug, cellId } = input;
      if (
        typeof orgId !== "string" ||
        typeof slug !== "string" ||
        typeof cellId !== "string" ||
        orgId.length !== 36 ||
        !CANONICAL_UUID.test(orgId) ||
        !isOrgSlug(slug) ||
        !isCellId(cellId)
      ) {
        throw new DirectoryRegistrationError("invalid_input");
      }
      for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt += 1) {
        const outcome = await reserve(db, { orgId, slug, cellId });
        if (outcome !== undefined) return outcome;
      }
      throw new DatabaseUnavailableError();
    },
    close: () => db.close(),
  };
}
