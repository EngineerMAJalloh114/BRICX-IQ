import {
  actionForStatusChange,
  can,
  checkExpenseAction,
  isRole,
  tableWriteSchemas,
  type CrudOperation,
  type ExpenseAction,
  type ExpenseStatus,
  type Permission,
  type Role,
  type WritableTable,
} from '@bricx/shared';
import pg from 'pg';

// Keep DATE columns as 'YYYY-MM-DD' strings rather than local-midnight Dates.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export class UploadRejected extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

type Row = Record<string, unknown>;

// Only the columns in a table's write schema are ever taken from client data;
// ids, ownership, workflow stamps and timestamps are controlled by the server.
function validate(op: CrudOperation, partial: boolean): Row {
  const schema = tableWriteSchemas[op.table];
  const allowed = new Set(Object.keys(schema.shape));
  const data = Object.fromEntries(
    Object.entries(op.data ?? {}).filter(([column]) => allowed.has(column)),
  );
  const result = (partial ? schema.partial() : schema).safeParse(data);
  if (!result.success) {
    throw new UploadRejected(`Invalid ${op.op} on ${op.table}/${op.id}`, result.error.issues);
  }
  return result.data as Row;
}

async function roleIn(
  client: pg.PoolClient,
  actorId: string,
  organisationId: unknown,
): Promise<Role | null> {
  if (typeof organisationId !== 'string') return null;
  const { rows } = await client.query<{ role: string }>(
    'SELECT role FROM memberships WHERE organisation_id = $1 AND user_id = $2',
    [organisationId, actorId],
  );
  const role = rows[0]?.role;
  return role && isRole(role) ? role : null;
}

async function projectOrganisation(client: pg.PoolClient, projectId: unknown): Promise<unknown> {
  if (typeof projectId !== 'string') return null;
  const { rows } = await client.query<{ organisation_id: string }>(
    'SELECT organisation_id FROM projects WHERE id = $1',
    [projectId],
  );
  return rows[0]?.organisation_id ?? null;
}

function forbidden(op: CrudOperation, reason: string): UploadRejected {
  return new UploadRejected(`Not allowed: ${op.op} on ${op.table}/${op.id}`, { reason });
}

function requirePermission(op: CrudOperation, role: Role, permission: Permission): void {
  if (!can(role, permission)) throw forbidden(op, `missing ${permission}`);
}

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/** Compare a client value with a stored one, e.g. 0.0433 with NUMERIC "0.043300000000". */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  const x = String(a);
  const y = String(b);
  if (DECIMAL_RE.test(x) && DECIMAL_RE.test(y)) {
    const trim = (s: string) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s);
    return trim(x) === trim(y);
  }
  return x === y;
}

/** The workflow actions an expense change amounts to, e.g. edit + submit. */
function expenseActions(op: CrudOperation, before: Row, data: Row): ExpenseAction[] {
  if (op.op === 'DELETE') return ['delete'];
  const actions: ExpenseAction[] = [];
  const from = before.status as ExpenseStatus;
  const content = Object.keys(data).filter(
    (c) => c !== 'status' && c !== 'rejection_reason' && !sameValue(data[c], before[c]),
  );
  if (content.length > 0) actions.push('edit');
  const to = (data.status as ExpenseStatus | undefined) ?? from;
  if (to !== from) {
    const action = actionForStatusChange(from, to);
    if (!action) throw new UploadRejected(`Expense cannot go from ${from} to ${to}`);
    actions.push(action);
  }
  return actions;
}

/**
 * Checks the actor's role in the row's organisation before a change is
 * applied. The database enforces the same workflow rules again.
 */
async function authorize(
  client: pg.PoolClient,
  actorId: string,
  op: CrudOperation,
  before: Row | null,
  data: Row,
): Promise<void> {
  const table: WritableTable = op.table;
  const organisationId =
    before?.organisation_id ??
    (table === 'projects'
      ? data.organisation_id
      : await projectOrganisation(client, data.project_id));
  const role = await roleIn(client, actorId, organisationId);
  if (!role) throw forbidden(op, 'not a member of this organisation');

  switch (table) {
    case 'projects':
      requirePermission(
        op,
        role,
        !before ? 'projects.create' : op.op === 'DELETE' ? 'projects.delete' : 'projects.edit',
      );
      return;
    case 'budget_lines':
      requirePermission(op, role, 'budget.edit');
      return;
    case 'expenses': {
      if (!before) {
        requirePermission(op, role, 'expenses.create');
        return;
      }
      const state = {
        status: before.status as ExpenseStatus,
        createdBy: String(before.created_by),
        submittedBy: (before.submitted_by as string | null) ?? null,
        deletedAt: before.deleted_at ? String(before.deleted_at) : null,
      };
      for (const action of expenseActions(op, before, data)) {
        const denial = checkExpenseAction({ userId: actorId, role }, state, action);
        if (denial) throw forbidden(op, `${action}: ${denial.reason}`);
      }
      return;
    }
  }
}

/** A database rule refused the change: the data is wrong, so retrying cannot help. */
function isRuleViolation(error: unknown): boolean {
  const code = (error as { code?: string }).code ?? '';
  // Integrity violations (23xxx) and the codes the workflow triggers raise:
  // insufficient_privilege, object_not_in_prerequisite_state, bad input.
  return code.startsWith('23') || code === '42501' || code === '55000' || code === '22P02';
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
        await authorize(client, actorId, op, before, {});
        await client.query(
          `UPDATE ${table} SET deleted_at = now(), updated_at = now() WHERE id = $1`,
          [op.id],
        );
        continue;
      }

      const data = validate(op, op.op === 'PATCH');

      if (!before) {
        if (op.op === 'PATCH') throw new UploadRejected(`${table}/${op.id} does not exist`);
        await authorize(client, actorId, op, null, data);
        const names = ['id', 'created_by', ...Object.keys(data)];
        const values = [op.id, actorId, ...Object.values(data)];
        await client.query(
          `INSERT INTO ${table} (${names.join(', ')})
           VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
          values,
        );
        continue;
      }

      if (before.deleted_at) throw new UploadRejected(`${table}/${op.id} was deleted`);
      // A retried upload repeats values the server already has; skip those so
      // it neither trips the workflow rules nor adds audit entries.
      const columns = Object.keys(data).filter((c) => !sameValue(data[c], before[c]));
      if (columns.length === 0) continue;
      await authorize(
        client,
        actorId,
        op,
        before,
        Object.fromEntries(columns.map((c) => [c, data[c]])),
      );
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
    if (!(error instanceof UploadRejected) && isRuleViolation(error)) {
      throw new UploadRejected((error as Error).message, {
        code: (error as { code?: string }).code,
      });
    }
    throw error;
  } finally {
    client.release();
  }
}
