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

/**
 * Applies one device transaction atomically. Database triggers record each
 * change in the audit log against app.actor_user_id, set here for the
 * transaction. Operations are idempotent so a retried upload is harmless.
 */
export async function applyOperations(
  pool: pg.Pool,
  actorId: string,
  operations: CrudOperation[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.actor_user_id', $1, true)", [actorId]);
    for (const op of operations) {
      // op.table is constrained to known table names by the upload schema.
      const table = op.table;
      const { rows } = await client.query<Row>(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [
        op.id,
      ]);
      const before = rows[0] ?? null;

      if (op.op === 'DELETE') {
        if (!before || before.deleted_at) continue;
        await client.query(
          `UPDATE ${table} SET deleted_at = now(), updated_at = now() WHERE id = $1`,
          [op.id],
        );
        continue;
      }

      const data = validate(op, op.op === 'PATCH');
      const columns = Object.keys(data);

      if (!before) {
        if (op.op === 'PATCH') throw new UploadRejected(`${table}/${op.id} does not exist`);
        const names = ['id', 'created_by', ...columns];
        const values = [op.id, actorId, ...columns.map((c) => data[c])];
        await client.query(
          `INSERT INTO ${table} (${names.join(', ')})
           VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
          values,
        );
        continue;
      }

      if (before.deleted_at) throw new UploadRejected(`${table}/${op.id} was deleted`);
      if (columns.length === 0) continue;
      const assignments = columns.map((c, i) => `${c} = $${i + 2}`);
      await client.query(
        `UPDATE ${table} SET ${assignments.join(', ')}, updated_at = now()
         WHERE id = $1`,
        [op.id, ...columns.map((c) => data[c])],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
