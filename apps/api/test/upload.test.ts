import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import { issueToken } from '../src/auth';
import { loadConfig } from '../src/config';
import { migrate } from '../src/migrate';

const config = loadConfig({ ...process.env, NODE_ENV: 'test' });
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = await buildApp(config, pool);
let token: string;
const userId = randomUUID();

beforeAll(async () => {
  await migrate(pool);
  token = await issueToken(config.JWT_SECRET, userId);
});

beforeEach(async () => {
  // audit_log is append-only, so tests scope their audit queries by row id.
  await pool.query('TRUNCATE projects');
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

function upload(operations: unknown[], auth = `Bearer ${token}`) {
  return app.inject({
    method: 'POST',
    url: '/sync/upload',
    headers: { authorization: auth },
    payload: { operations },
  });
}

const project = {
  name: 'Lumley Bridge',
  currency: 'SLE',
  budget_minor: 250000,
  status: 'planning',
};

describe('POST /sync/upload', () => {
  it('rejects requests without a valid token', async () => {
    expect((await upload([], '')).statusCode).toBe(401);
    expect((await upload([], 'Bearer nope')).statusCode).toBe(401);
    const notAUser = await issueToken(config.JWT_SECRET, 'user-1');
    expect((await upload([], `Bearer ${notAUser}`)).statusCode).toBe(401);
  });

  it('creates, updates and soft-deletes a project with a full audit trail', async () => {
    const id = randomUUID();
    expect((await upload([{ op: 'PUT', table: 'projects', id, data: project }])).statusCode).toBe(
      200,
    );
    expect(
      (await upload([{ op: 'PATCH', table: 'projects', id, data: { status: 'active' } }]))
        .statusCode,
    ).toBe(200);
    expect((await upload([{ op: 'DELETE', table: 'projects', id }])).statusCode).toBe(200);

    const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1', [id]);
    expect(rows[0]).toMatchObject({
      status: 'active',
      created_by: userId,
      budget_minor: '250000',
    });
    expect(rows[0].deleted_at).not.toBeNull();

    const audit = await pool.query(
      'SELECT action, actor_user_id, old_data, new_data FROM audit_log WHERE row_id = $1 ORDER BY id',
      [id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['INSERT', 'UPDATE', 'DELETE']);
    expect(audit.rows.every((r) => r.actor_user_id === userId)).toBe(true);
    expect(audit.rows[1].old_data.status).toBe('planning');
    expect(audit.rows[1].new_data.status).toBe('active');
  });

  it('is idempotent when a device retries the same upload', async () => {
    const id = randomUUID();
    const ops = [{ op: 'PUT', table: 'projects', id, data: project }];
    await upload(ops);
    expect((await upload(ops)).statusCode).toBe(200);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM projects');
    expect(rows[0].n).toBe(1);
  });

  it('applies a batch atomically and rejects invalid data', async () => {
    const good = randomUUID();
    const response = await upload([
      { op: 'PUT', table: 'projects', id: good, data: project },
      { op: 'PUT', table: 'projects', id: randomUUID(), data: { ...project, currency: 'ZZZ' } },
    ]);
    expect(response.statusCode).toBe(422);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM projects');
    expect(rows[0].n).toBe(0);
  });

  it('ignores columns clients may not write', async () => {
    const id = randomUUID();
    await upload([
      { op: 'PUT', table: 'projects', id, data: { ...project, created_by: 'someone-else' } },
    ]);
    const { rows } = await pool.query('SELECT created_by FROM projects WHERE id = $1', [id]);
    expect(rows[0].created_by).toBe(userId);
  });

  it('keeps the audit log append-only', async () => {
    const id = randomUUID();
    await upload([{ op: 'PUT', table: 'projects', id, data: project }]);
    await expect(pool.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
    await expect(pool.query("UPDATE audit_log SET row_id = 'x'")).rejects.toThrow(/append-only/);
  });
});

describe('POST /auth/dev-token', () => {
  it('signs in as a users row so changes are attributed to it', async () => {
    const email = `dev-${randomUUID()}@bricx.test`;
    const first = await app.inject({ method: 'POST', url: '/auth/dev-token', payload: { email } });
    const again = await app.inject({
      method: 'POST',
      url: '/auth/dev-token',
      payload: { email: email.toUpperCase() },
    });
    expect(first.statusCode).toBe(200);
    const { rows } = await pool.query('SELECT id FROM users WHERE lower(email) = lower($1)', [
      email,
    ]);
    expect(rows).toHaveLength(1);
    const sub = (t: string) =>
      JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString()).sub;
    expect(sub(first.json().token)).toBe(rows[0].id);
    expect(sub(again.json().token)).toBe(rows[0].id);
  });
});

describe('GET /health', () => {
  it('reports the database is reachable', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
