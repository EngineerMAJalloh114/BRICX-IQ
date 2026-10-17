// TemplateItems' repository (P4-09, ADR 0059): every statement runs in the
// `tx` TxRunner hands over (withTx(), CLAUDE.md rule 4), as bricx_app under
// RLS. A unique violation (SQLSTATE 23505: the same name in the project,
// or the same id) is caught here and only here, and becomes
// ApiError("request.conflict") (409) at once: nothing else runs in that
// transaction, which rolls back with the idempotency claim (owner
// condition 4).
import { type Tx, sqlstateOf } from "@bricx/db/database";
import type { AccessFilter } from "@bricx/permissions/ability";
import { Injectable } from "@nestjs/common";
import { type SQL, and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { ApiError } from "../../common/errors/api-error.js";
import type { TemplateItemData } from "./template-items.dto.js";
// new-module:template-only:start
import { templateItems } from "./template-items.schema.js";
// new-module:template-only:end
// new-module:copy-only: import { templateItems } from "@bricx/db/schema";

const UNIQUE_VIOLATION = "23505";

/** timestamptz as UTC ISO 8601 with microseconds, in SQL. */
const iso = (column: typeof templateItems.createdAt) =>
  sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const columns = {
  id: templateItems.id,
  projectId: templateItems.projectId,
  name: templateItems.name,
  createdBy: templateItems.createdBy,
  createdAt: iso(templateItems.createdAt),
  updatedAt: iso(templateItems.updatedAt),
  version: templateItems.version,
};

export interface NewTemplateItem {
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly name: string;
  readonly createdBy: string;
}

export interface TemplateItemsQuery {
  readonly projectId: string;
  readonly filters: readonly AccessFilter[];
  /** Only ids after this one (the cursor). */
  readonly after: string | undefined;
  readonly limit: number;
}

/** One permission filter as SQL; a site filter matches nothing here. */
function filterSql(filter: AccessFilter): SQL | undefined {
  if (filter.siteIds !== undefined) return undefined;
  return and(
    eq(templateItems.orgId, filter.orgId),
    filter.projectIds === undefined
      ? undefined
      : inArray(templateItems.projectId, [...filter.projectIds]),
    filter.createdBy === undefined
      ? undefined
      : eq(templateItems.createdBy, filter.createdBy),
  );
}

@Injectable()
export class TemplateItemsRepository {
  /** Inserts one row; a unique violation is ApiError("request.conflict"). */
  async insert(tx: Tx, item: NewTemplateItem): Promise<TemplateItemData> {
    let rows: TemplateItemData[];
    try {
      rows = await tx.insert(templateItems).values(item).returning(columns);
    } catch (error) {
      if (sqlstateOf(error) === UNIQUE_VIOLATION) {
        throw new ApiError("request.conflict");
      }
      throw error;
    }
    const [row] = rows;
    if (row === undefined) throw new Error("insert returned no row");
    return row;
  }

  /** The row with `id` that RLS lets the transaction see, if any. */
  async findById(tx: Tx, id: string): Promise<TemplateItemData | undefined> {
    const [row] = await tx
      .select(columns)
      .from(templateItems)
      .where(eq(templateItems.id, id));
    return row;
  }

  /** Up to `limit` rows of one project matching a filter, by id. */
  async list(tx: Tx, query: TemplateItemsQuery): Promise<TemplateItemData[]> {
    const allowed = query.filters
      .map(filterSql)
      .filter((f): f is SQL => f !== undefined);
    if (allowed.length === 0) return [];
    return tx
      .select(columns)
      .from(templateItems)
      .where(
        and(
          eq(templateItems.projectId, query.projectId),
          or(...allowed),
          query.after === undefined
            ? undefined
            : gt(templateItems.id, query.after),
        ),
      )
      .orderBy(asc(templateItems.id))
      .limit(query.limit);
  }
}
