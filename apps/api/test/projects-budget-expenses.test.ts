import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config';
import { migrate } from '../src/migrate';

// The database rules for projects, budget lines and expenses, checked
// directly so they hold whichever code path writes the data.

const config = loadConfig({ ...process.env, NODE_ENV: 'test' });
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
let db: pg.PoolClient;

const org = randomUUID();
const otherOrg = randomUUID();
const pm = randomUUID();
const site = randomUUID();
const project = randomUUID();
const otherProject = randomUUID();
const cement = randomUUID();
const masons = randomUUID();

beforeAll(async () => {
  await migrate(pool);
});

async function as(user: string) {
  await db.query("SELECT set_config('app.actor_user_id', $1, true)", [user]);
}

// Each test runs in a transaction that is rolled back, because audit_log is
// append-only and cannot be cleaned up afterwards.
beforeEach(async () => {
  db = await pool.connect();
  await db.query('BEGIN');
  await as(pm);
  await db.query(
    `INSERT INTO organisations (id, name, base_currency) VALUES ($1, 'Freetown Builders', 'USD'), ($2, 'Other', 'EUR')`,
    [org, otherOrg],
  );
  await db.query(
    `INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'PM'), ($3, $4, 'Site')`,
    [pm, `pm-${pm}@bricx.test`, site, `site-${site}@bricx.test`],
  );
  await db.query(
    `INSERT INTO projects (id, organisation_id, code, name, currency, status, created_by) VALUES
       ($1, $2, 'BX-001', 'Lumley Road Clinic', 'USD', 'active', $5),
       ($3, $4, 'OC-001', 'Other project', 'EUR', 'active', $5)`,
    [project, org, otherProject, otherOrg, pm],
  );
  await db.query(
    `INSERT INTO budget_lines (id, project_id, category, description, amount_minor, amount_currency, created_by) VALUES
       ($1, $3, 'materials', 'Cement and blocks', 1000000, 'USD', $4),
       ($2, $3, 'labour', 'Masons', 500000, 'USD', $4)`,
    [cement, masons, project, pm],
  );
});

afterEach(async () => {
  await db.query('ROLLBACK');
  db.release();
});

afterAll(async () => {
  await pool.end();
});

async function expectError(sql: string, params: unknown[], code: string) {
  await db.query('SAVEPOINT s');
  await expect(db.query(sql, params)).rejects.toMatchObject({ code });
  await db.query('ROLLBACK TO SAVEPOINT s');
}

interface ExpenseValues {
  id?: string;
  project_id?: string;
  budget_line_id?: string | null;
  amount_minor?: number;
  amount_currency?: string;
  fx_rate?: string;
  fx_rate_date?: string;
  fx_rate_source?: string;
  fx_manual_reason?: string | null;
  base_amount_minor?: number;
  base_amount_currency?: string;
  status?: string;
}

const insertExpense = `INSERT INTO expenses (id, project_id, budget_line_id, category, description,
  incurred_on, amount_minor, amount_currency, fx_rate, fx_rate_date, fx_rate_source,
  fx_manual_reason, base_amount_minor, base_amount_currency, status, created_by)
  VALUES ($1, $2, $3, 'materials', 'Cement', '2026-09-20', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`;

function expenseParams(v: ExpenseValues = {}): unknown[] {
  return [
    v.id ?? randomUUID(),
    v.project_id ?? project,
    v.budget_line_id === undefined ? cement : v.budget_line_id,
    v.amount_minor ?? 250000,
    v.amount_currency ?? 'USD',
    v.fx_rate ?? '1',
    v.fx_rate_date ?? '2026-09-20',
    v.fx_rate_source ?? 'same_currency',
    v.fx_manual_reason ?? null,
    v.base_amount_minor ?? v.amount_minor ?? 250000,
    v.base_amount_currency ?? 'USD',
    v.status ?? 'draft',
    site,
  ];
}

async function newExpense(v: ExpenseValues = {}): Promise<string> {
  const id = v.id ?? randomUUID();
  await as(site);
  await db.query(insertExpense, expenseParams({ ...v, id }));
  return id;
}

async function expense(id: string) {
  return (await db.query('SELECT * FROM expenses WHERE id = $1', [id])).rows[0];
}

describe('projects', () => {
  it('keeps ownership fixed and project codes unique per organisation', async () => {
    await db.query(`UPDATE projects SET organisation_id = $2, created_by = $3 WHERE id = $1`, [
      project,
      otherOrg,
      site,
    ]);
    const { rows } = await db.query(
      'SELECT organisation_id, created_by FROM projects WHERE id = $1',
      [project],
    );
    expect(rows[0]).toEqual({ organisation_id: org, created_by: pm });
    await expectError(
      `INSERT INTO projects (id, organisation_id, code, name, currency, created_by) VALUES ($1, $2, 'bx-001', 'Dup', 'USD', $3)`,
      [randomUUID(), org, pm],
      '23505',
    );
  });

  it('fixes the currency once money is recorded, and never hard-deletes', async () => {
    await expectError(`UPDATE projects SET currency = 'EUR' WHERE id = $1`, [project], '55000');
    await expectError(`DELETE FROM projects WHERE id = $1`, [project], '23001');
  });
});

describe('budget lines', () => {
  it('takes the organisation from the project and must use its currency', async () => {
    const { rows } = await db.query('SELECT organisation_id FROM budget_lines WHERE id = $1', [
      cement,
    ]);
    expect(rows[0].organisation_id).toBe(org);
    await expectError(
      `INSERT INTO budget_lines (id, project_id, category, description, amount_minor, amount_currency, created_by)
       VALUES ($1, $2, 'other', 'x', 100, 'EUR', $3)`,
      [randomUUID(), project, pm],
      '23514',
    );
  });

  it('cannot be deleted while expenses are booked to it', async () => {
    await newExpense();
    await expectError(
      `UPDATE budget_lines SET deleted_at = now() WHERE id = $1`,
      [cement],
      '55000',
    );
    await db.query(`UPDATE budget_lines SET deleted_at = now() WHERE id = $1`, [masons]);
    await expectError(insertExpense, expenseParams({ budget_line_id: masons }), '55000');
  });
});

describe('expenses', () => {
  it('stores a converted amount only if it matches the stored rate', async () => {
    // 22,500.00 SLE at 1 SLE = 0.044444444444 USD is 1,000.00 USD.
    const ok = {
      amount_minor: 2250000,
      amount_currency: 'SLE',
      fx_rate: '0.044444444444',
      fx_rate_source: 'global',
    };
    await newExpense({ ...ok, base_amount_minor: 100000 });
    await expectError(insertExpense, expenseParams({ ...ok, base_amount_minor: 120000 }), '23514');
    await expectError(
      insertExpense,
      expenseParams({ amount_currency: 'EUR', base_amount_currency: 'EUR', amount_minor: 1000 }),
      '23514',
    );
    await expectError(
      insertExpense,
      expenseParams({
        amount_currency: 'EUR',
        amount_minor: 1000,
        fx_rate: '1.1',
        fx_rate_source: 'manual',
        base_amount_minor: 1100,
      }),
      '23514',
    );
  });

  it('is created as a draft, in the project’s organisation only', async () => {
    await expectError(insertExpense, expenseParams({ status: 'approved' }), '23514');
    await expectError(
      insertExpense,
      expenseParams({
        project_id: otherProject,
        budget_line_id: cement,
        amount_currency: 'EUR',
        base_amount_currency: 'EUR',
      }),
      '23503',
    );
    expect((await expense(await newExpense())).organisation_id).toBe(org);
  });

  it('stamps submission and approval, and keeps the submitter from deciding', async () => {
    const id = await newExpense();
    await db.query(`UPDATE expenses SET status = 'submitted' WHERE id = $1`, [id]);
    expect(await expense(id)).toMatchObject({ status: 'submitted', submitted_by: site });
    await expectError(`UPDATE expenses SET status = 'approved' WHERE id = $1`, [id], '42501');
    await expectError(`UPDATE expenses SET description = 'x' WHERE id = $1`, [id], '55000');
    // Approval stamps cannot be forged by a plain update.
    await db.query(`UPDATE expenses SET decided_by = $2 WHERE id = $1`, [id, pm]);
    expect((await expense(id)).decided_by).toBeNull();

    await as(pm);
    await db.query(`UPDATE expenses SET status = 'approved' WHERE id = $1`, [id]);
    expect(await expense(id)).toMatchObject({ status: 'approved', decided_by: pm });
    for (const sql of [
      `UPDATE expenses SET vendor = 'x' WHERE id = $1`,
      `UPDATE expenses SET status = 'draft' WHERE id = $1`,
      `UPDATE expenses SET deleted_at = now() WHERE id = $1`,
    ]) {
      await expectError(sql, [id], '55000');
    }
    await expectError(`DELETE FROM expenses WHERE id = $1`, [id], '23001');
  });

  it('needs a reason to reject, then can be reopened, fixed and deleted', async () => {
    const id = await newExpense();
    await db.query(`UPDATE expenses SET status = 'submitted' WHERE id = $1`, [id]);
    await as(pm);
    await expectError(`UPDATE expenses SET status = 'rejected' WHERE id = $1`, [id], '23514');
    await db.query(
      `UPDATE expenses SET status = 'rejected', rejection_reason = 'No receipt' WHERE id = $1`,
      [id],
    );
    await expectError(`UPDATE expenses SET status = 'approved' WHERE id = $1`, [id], '23514');
    await as(site);
    await db.query(`UPDATE expenses SET status = 'draft' WHERE id = $1`, [id]);
    await db.query(`UPDATE expenses SET description = 'Cement, receipt attached' WHERE id = $1`, [
      id,
    ]);
    await db.query(`UPDATE expenses SET deleted_at = now() WHERE id = $1`, [id]);

    const { rows } = await db.query(
      `SELECT action, actor_user_id FROM audit_log WHERE table_name = 'expenses' AND row_id = $1 ORDER BY id`,
      [id],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'INSERT',
      'UPDATE',
      'UPDATE',
      'UPDATE',
      'UPDATE',
      'DELETE',
    ]);
    expect(rows[2].actor_user_id).toBe(pm);
  });
});

describe('project_budget_summary', () => {
  it('reports budget, approved and pending spend in the project currency', async () => {
    const approved = await newExpense({ amount_minor: 250000 });
    const pending = await newExpense({ amount_minor: 30000, budget_line_id: null });
    await newExpense({ amount_minor: 99999 }); // draft, not counted
    await db.query(`UPDATE expenses SET status = 'submitted' WHERE id = ANY($1)`, [
      [approved, pending],
    ]);
    await as(pm);
    await db.query(`UPDATE expenses SET status = 'approved' WHERE id = $1`, [approved]);

    const { rows } = await db.query('SELECT * FROM project_budget_summary WHERE project_id = $1', [
      project,
    ]);
    expect(rows[0]).toMatchObject({
      organisation_id: org,
      currency: 'USD',
      budget_minor: '1500000',
      approved_minor: '250000',
      pending_minor: '30000',
    });
  });
});
