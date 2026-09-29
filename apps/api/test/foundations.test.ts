import { randomUUID } from 'node:crypto';

import { currencyMinorDigits, ROLES } from '@bricx/shared';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config';
import { migrate } from '../src/migrate';

const config = loadConfig({ ...process.env, NODE_ENV: 'test' });
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
let db: pg.PoolClient;

const actor = randomUUID();
const org = randomUUID();
const owner = randomUUID();

beforeAll(async () => {
  await migrate(pool);
});

// Each test runs in a transaction that is rolled back, because audit_log is
// append-only and cannot be cleaned up afterwards.
beforeEach(async () => {
  db = await pool.connect();
  await db.query('BEGIN');
  await db.query("SELECT set_config('app.actor_user_id', $1, true)", [actor]);
  await db.query(`INSERT INTO organisations (id, name, base_currency) VALUES ($1, 'Acme', 'USD')`, [
    org,
  ]);
  await db.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Owner')`, [
    owner,
    `owner-${owner}@acme.test`,
  ]);
  await db.query(
    `INSERT INTO memberships (organisation_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [org, owner],
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

async function auditRows(table: string, rowId: string) {
  const { rows } = await db.query(
    `SELECT action, actor_user_id, organisation_id, old_data, new_data
     FROM audit_log WHERE table_name = $1 AND row_id = $2 ORDER BY id`,
    [table, rowId],
  );
  return rows;
}

describe('audit log', () => {
  it('records every change with the actor, organisation and before/after values', async () => {
    await db.query(`UPDATE memberships SET role = 'admin' WHERE user_id = $1`, [owner]);
    await db.query(`UPDATE memberships SET role = 'admin' WHERE user_id = $1`, [owner]); // no-op
    const rows = await auditRows('memberships', `${org}:${owner}`);
    expect(rows.map((r) => r.action)).toEqual(['INSERT', 'UPDATE']);
    expect(rows[1]).toMatchObject({
      actor_user_id: actor,
      organisation_id: org,
      old_data: expect.objectContaining({ role: 'owner' }),
      new_data: expect.objectContaining({ role: 'admin' }),
    });
    expect((await auditRows('organisations', org))[0].organisation_id).toBe(org);
  });

  it('logs a soft delete as DELETE', async () => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO projects (id, name, currency, created_by) VALUES ($1, 'Bridge', 'SLE', $2)`,
      [id, actor],
    );
    await db.query(`UPDATE projects SET deleted_at = now() WHERE id = $1`, [id]);
    expect((await auditRows('projects', id)).map((r) => r.action)).toEqual(['INSERT', 'DELETE']);
  });

  it('rejects UPDATE, DELETE and TRUNCATE', async () => {
    for (const sql of [
      `UPDATE audit_log SET row_id = 'x'`,
      'DELETE FROM audit_log',
      'TRUNCATE audit_log',
    ]) {
      await expectError(sql, [], '42501');
    }
  });

  it('detects tampering through the hash chain', async () => {
    await db.query(`UPDATE memberships SET role = 'viewer' WHERE user_id = $1`, [owner]);
    expect((await db.query('SELECT audit_verify_chain() AS broken')).rows[0].broken).toBeNull();

    // Simulate someone with superuser access bypassing the append-only trigger.
    await db.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
    const { rows } = await db.query(
      `UPDATE audit_log SET new_data = jsonb_set(new_data, '{role}', '"owner"')
       WHERE table_name = 'memberships' AND row_id = $1 AND action = 'UPDATE' RETURNING id`,
      [`${org}:${owner}`],
    );
    expect((await db.query('SELECT audit_verify_chain() AS broken')).rows[0].broken).toBe(
      rows[0].id,
    );
  });
});

describe('organisations and users', () => {
  it('keeps the member_role enum in step with the shared ROLES', async () => {
    const { rows } = await db.query(`SELECT unnest(enum_range(NULL::member_role))::text AS role`);
    expect(rows.map((r) => r.role)).toEqual([...ROLES]);
  });

  it('treats emails case-insensitively', async () => {
    await expectError(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Dup')`,
      [`OWNER-${owner}@acme.test`],
      '23505',
    );
  });
});

describe('money and exchange rates', () => {
  it('seeds exactly the currencies the shared package knows', async () => {
    const { rows } = await db.query('SELECT code, minor_units FROM currencies ORDER BY code');
    expect(Object.fromEntries(rows.map((r) => [r.code, r.minor_units]))).toEqual(
      currencyMinorDigits,
    );
  });

  it('uses the rate in force on a date, preferring the organisation’s own', async () => {
    await db.query(
      `INSERT INTO exchange_rates (base_currency, quote_currency, rate, effective_date)
       VALUES ('XCD', 'SLE', '8.30', '2026-01-01'), ('XCD', 'SLE', '8.55', '2026-06-01')`,
    );
    await db.query(
      `INSERT INTO exchange_rates (organisation_id, base_currency, quote_currency, rate, effective_date)
       VALUES ($1, 'XCD', 'SLE', '8.40', '2026-01-01')`,
      [org],
    );
    const rate = async (o: string | null, date: string) =>
      (await db.query(`SELECT exchange_rate_on($1, 'XCD', 'SLE', $2) AS r`, [o, date])).rows[0].r;
    expect(await rate(null, '2026-03-01')).toBe('8.300000000000');
    expect(await rate(null, '2026-07-01')).toBe('8.550000000000');
    expect(await rate(org, '2026-03-01')).toBe('8.400000000000');
    expect(await rate(null, '2025-12-31')).toBeNull();
  });

  it('rejects bad rates and unknown currencies', async () => {
    const insert = `INSERT INTO exchange_rates (base_currency, quote_currency, rate, effective_date)
                    VALUES ($1, $2, $3, '2026-01-02')`;
    await expectError(insert, ['USD', 'SLE', 0], '23514');
    await expectError(insert, ['USD', 'USD', 1], '23514');
    await expectError(insert, ['USD', 'ZZZ', 1], '23503');
    await expectError(
      `INSERT INTO organisations (name, base_currency) VALUES ('Bad', 'usd')`,
      [],
      '23514',
    );
    await expectError(
      `INSERT INTO projects (id, name, currency, created_by) VALUES ($1, 'P', 'ZZZ', 'x')`,
      [randomUUID()],
      '23503',
    );
  });
});
