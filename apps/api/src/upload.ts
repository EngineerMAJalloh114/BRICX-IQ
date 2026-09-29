import {
  syncedTables,
  tableWriteSchemas,
  type CrudOperation,
  type SyncedTable,
} from '@bricx/shared';
import type pg from 'pg';

export class UploadRejected extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

type Row = Record<string, unknown>;

// Only these columns are ever written from client data; ids, ownership and
// timestamps are controlled by the server.
function writableColumns(table: SyncedTable): string[] {
  return Object.keys(syncedTables[table]).filter((c) => c !== 'created_at' && c !== 'updated_at');
}

function validate(op: CrudOperation, partial: boolean): Row {
  const schema = tableWriteSchemas[op.table];
  const allowed = new Set(writableColumns(op.table));
  const data = Object.fromEntries(
    Object.entries(op.data ?? {}).filter(([column]) => allowed.has(column)),
  );
  const result = (partial ? schema.partial() : schema).safeParse(data);
  if (!result.success) {
    throw new UploadRejected(`Invalid ${op.op} on ${op.table}/${op.id}`, result.error.issues);
  }
  return result.data as Row;
}

async function audit(
  client: pg.PoolClient,
  actorId: string,
  action: 'create' | 'update' | 'delete',
  op: CrudOperation,
  before: Row | null,
  after: Row | null,
) {
  await client.query(
    `INSERT INTO audit_log (actor_id, action, table_name, row_id, before, after)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [actorId, action, op.table, op.id, before, after],
  );
}

/**
 * Applies one device transaction atomically and records each change in the
 * audit log. Operations are idempotent so a retried upload is harmless.
 */
export async function applyOperations(
  pool: pg.Pool,
  actorId: string,
  operations: CrudOperation[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const op of operations) {
      // op.table is constrained to known table names by the upload schema.
      const table = op.table;
      const { rows } = await client.query<Row>(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [
        op.id,
      ]);
      const before = rows[0] ?? null;

      if (op.op === 'DELETE') {
        if (!before || before.deleted_at) continue;
        const { rows: after } = await client.query<Row>(
          `UPDATE ${table} SET deleted_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
          [op.id],
        );
        await audit(client, actorId, 'delete', op, before, after[0]!);
        continue;
      }

      const data = validate(op, op.op === 'PATCH');
      const columns = Object.keys(data);

      if (!before) {
        if (op.op === 'PATCH') throw new UploadRejected(`${table}/${op.id} does not exist`);
        const names = ['id', 'created_by', ...columns];
        const values = [op.id, actorId, ...columns.map((c) => data[c])];
        const { rows: after } = await client.query<Row>(
          `INSERT INTO ${table} (${names.join(', ')})
           VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
          values,
        );
        await audit(client, actorId, 'create', op, null, after[0]!);
        continue;
      }

      if (before.deleted_at) throw new UploadRejected(`${table}/${op.id} was deleted`);
      if (columns.length === 0) continue;
      const assignments = columns.map((c, i) => `${c} = $${i + 2}`);
      const { rows: after } = await client.query<Row>(
        `UPDATE ${table} SET ${assignments.join(', ')}, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [op.id, ...columns.map((c) => data[c])],
      );
      await audit(client, actorId, 'update', op, before, after[0]!);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
