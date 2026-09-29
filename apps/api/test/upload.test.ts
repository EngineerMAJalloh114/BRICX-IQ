import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import { issueToken } from '../src/auth';
import { loadConfig } from '../src/config';
import { migrate } from '../src/migrate';

const config = loadConfig({ ...process.env, NODE_ENV: 'test' });
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = await buildApp(config, pool);

// Every test works in its own organisation, so nothing needs cleaning up
// (audit_log is append-only and rows are soft-deleted).
interface Org {
  id: string;
  tokens: Record<string, string>;
  users: Record<string, string>;
}

const ROLES = ['owner', 'project_manager', 'site_supervisor', 'worker', 'viewer'] as const;

async function newOrg(): Promise<Org> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO organisations (id, name, base_currency) VALUES ($1, 'Acme', 'USD')`,
    [id],
  );
  const org: Org = { id, tokens: {}, users: {} };
  for (const role of ROLES) {
    const userId = randomUUID();
    await pool.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [
      userId,
      `${role}-${userId}@bricx.test`,
      role,
    ]);
    await pool.query(
      `INSERT INTO memberships (organisation_id, user_id, role) VALUES ($1, $2, $3)`,
      [id, userId, role],
    );
    org.users[role] = userId;
    org.tokens[role] = await issueToken(config.JWT_SECRET, userId);
  }
  return org;
}

beforeAll(async () => {
  await migrate(pool);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

function upload(operations: unknown[], token: string | undefined) {
  return app.inject({
    method: 'POST',
    url: '/sync/upload',
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    payload: { operations },
  });
}

const project = (org: Org) => ({
  organisation_id: org.id,
  name: 'Lumley Bridge',
  currency: 'USD',
  status: 'planning',
});

async function createProject(org: Org): Promise<string> {
  const id = randomUUID();
  const res = await upload(
    [{ op: 'PUT', table: 'projects', id, data: project(org) }],
    org.tokens.owner,
  );
  expect(res.statusCode).toBe(200);
  return id;
}

describe('POST /sync/upload', () => {
  it('rejects requests without a valid token', async () => {
    expect((await upload([], undefined)).statusCode).toBe(401);
    expect((await upload([], 'nope')).statusCode).toBe(401);
    const notAUser = await issueToken(config.JWT_SECRET, 'user-1');
    expect((await upload([], notAUser)).statusCode).toBe(401);
  });

  it('creates, updates and soft-deletes a project with a full audit trail', async () => {
    const org = await newOrg();
    const id = randomUUID();
    const token = org.tokens.owner;
    expect(
      (await upload([{ op: 'PUT', table: 'projects', id, data: project(org) }], token)).statusCode,
    ).toBe(200);
    expect(
      (await upload([{ op: 'PATCH', table: 'projects', id, data: { status: 'active' } }], token))
        .statusCode,
    ).toBe(200);
    expect((await upload([{ op: 'DELETE', table: 'projects', id }], token)).statusCode).toBe(200);

    const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1', [id]);
    expect(rows[0]).toMatchObject({
      status: 'active',
      organisation_id: org.id,
      created_by: org.users.owner,
    });
    expect(rows[0].deleted_at).not.toBeNull();

    const audit = await pool.query(
      'SELECT action, actor_user_id, organisation_id, old_data, new_data FROM audit_log WHERE row_id = $1 ORDER BY id',
      [id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['INSERT', 'UPDATE', 'DELETE']);
    expect(audit.rows.every((r) => r.actor_user_id === org.users.owner)).toBe(true);
    expect(audit.rows.every((r) => r.organisation_id === org.id)).toBe(true);
    expect(audit.rows[1].old_data.status).toBe('planning');
    expect(audit.rows[1].new_data.status).toBe('active');
  });

  it('is idempotent when a device retries the same upload', async () => {
    const org = await newOrg();
    const ops = [{ op: 'PUT', table: 'projects', id: randomUUID(), data: project(org) }];
    await upload(ops, org.tokens.owner);
    expect((await upload(ops, org.tokens.owner)).statusCode).toBe(200);
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM projects WHERE organisation_id = $1',
      [org.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('applies a batch atomically and rejects invalid data', async () => {
    const org = await newOrg();
    const response = await upload(
      [
        { op: 'PUT', table: 'projects', id: randomUUID(), data: project(org) },
        {
          op: 'PUT',
          table: 'projects',
          id: randomUUID(),
          data: { ...project(org), currency: 'ZZZ' },
        },
      ],
      org.tokens.owner,
    );
    expect(response.statusCode).toBe(422);
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM projects WHERE organisation_id = $1',
      [org.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('ignores columns clients may not write', async () => {
    const org = await newOrg();
    const id = randomUUID();
    await upload(
      [{ op: 'PUT', table: 'projects', id, data: { ...project(org), created_by: randomUUID() } }],
      org.tokens.owner,
    );
    const { rows } = await pool.query('SELECT created_by FROM projects WHERE id = $1', [id]);
    expect(rows[0].created_by).toBe(org.users.owner);
  });

  it('only lets members with the right role change an organisation’s projects', async () => {
    const org = await newOrg();
    const outsider = await newOrg();
    const id = randomUUID();
    const put = [{ op: 'PUT', table: 'projects', id, data: project(org) }];
    expect((await upload(put, outsider.tokens.owner)).statusCode).toBe(422);
    expect((await upload(put, org.tokens.site_supervisor)).statusCode).toBe(422);
    expect((await upload(put, org.tokens.project_manager)).statusCode).toBe(200);
    // Project managers can edit but not delete; moving a project to another
    // organisation is ignored.
    const pm = org.tokens.project_manager;
    expect(
      (
        await upload(
          [{ op: 'PATCH', table: 'projects', id, data: { organisation_id: outsider.id } }],
          pm,
        )
      ).statusCode,
    ).toBe(200);
    expect((await upload([{ op: 'DELETE', table: 'projects', id }], pm)).statusCode).toBe(422);
    const { rows } = await pool.query(
      'SELECT organisation_id, deleted_at FROM projects WHERE id = $1',
      [id],
    );
    expect(rows[0]).toEqual({ organisation_id: org.id, deleted_at: null });
  });
});

describe('budgets and expenses through sync', () => {
  it('stores budget lines under the project’s organisation, in its currency', async () => {
    const org = await newOrg();
    const projectId = await createProject(org);
    const line = {
      project_id: projectId,
      category: 'materials',
      description: 'Cement and blocks',
      amount_minor: 1_000_000,
      amount_currency: 'USD',
    };
    const id = randomUUID();
    expect(
      (
        await upload(
          [{ op: 'PUT', table: 'budget_lines', id, data: line }],
          org.tokens.site_supervisor,
        )
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await upload(
          [
            {
              op: 'PUT',
              table: 'budget_lines',
              id: randomUUID(),
              data: { ...line, amount_currency: 'EUR' },
            },
          ],
          org.tokens.project_manager,
        )
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await upload(
          [{ op: 'PUT', table: 'budget_lines', id, data: line }],
          org.tokens.project_manager,
        )
      ).statusCode,
    ).toBe(200);
    const { rows } = await pool.query('SELECT organisation_id FROM budget_lines WHERE id = $1', [
      id,
    ]);
    expect(rows[0].organisation_id).toBe(org.id);
  });

  it('runs an expense from entry in Leones to approval, enforcing who can do what', async () => {
    const org = await newOrg();
    const projectId = await createProject(org);
    const id = randomUUID();
    // 4,620.00 SLE at 1 USD = 23.10 SLE, as computed on the device.
    const expense = {
      project_id: projectId,
      category: 'materials',
      description: 'Cement, 20 bags',
      incurred_on: '2026-07-15',
      amount_minor: 462000,
      amount_currency: 'SLE',
      fx_rate: '0.04329004329',
      fx_rate_date: '2026-06-01',
      fx_rate_source: 'global',
      base_amount_minor: 20000,
      base_amount_currency: 'USD',
      status: 'draft',
    };
    const { site_supervisor: site, project_manager: pm, viewer } = org.tokens;
    const patch = (data: object) => [{ op: 'PATCH', table: 'expenses', id, data }];

    expect(
      (await upload([{ op: 'PUT', table: 'expenses', id, data: expense }], viewer)).statusCode,
    ).toBe(422);
    expect(
      (
        await upload(
          [{ op: 'PUT', table: 'expenses', id, data: { ...expense, base_amount_minor: 25000 } }],
          site,
        )
      ).statusCode,
    ).toBe(422);
    expect(
      (await upload([{ op: 'PUT', table: 'expenses', id, data: expense }], site)).statusCode,
    ).toBe(200);
    expect((await upload(patch({ status: 'submitted' }), site)).statusCode).toBe(200);
    // Nobody approves their own expense, and a site supervisor cannot approve.
    expect((await upload(patch({ status: 'approved' }), site)).statusCode).toBe(422);
    expect(
      (await upload(patch({ description: 'Changed after submitting' }), site)).statusCode,
    ).toBe(422);
    expect((await upload(patch({ status: 'approved' }), pm)).statusCode).toBe(200);
    // Final once approved, but a device re-sending the same row is harmless.
    expect((await upload(patch({ status: 'draft' }), pm)).statusCode).toBe(422);
    expect((await upload([{ op: 'DELETE', table: 'expenses', id }], pm)).statusCode).toBe(422);
    expect(
      (
        await upload(
          [{ op: 'PUT', table: 'expenses', id, data: { ...expense, status: 'approved' } }],
          pm,
        )
      ).statusCode,
    ).toBe(200);

    const { rows } = await pool.query('SELECT * FROM expenses WHERE id = $1', [id]);
    expect(rows[0]).toMatchObject({
      organisation_id: org.id,
      status: 'approved',
      created_by: org.users.site_supervisor,
      submitted_by: org.users.site_supervisor,
      decided_by: org.users.project_manager,
      base_amount_minor: '20000',
      deleted_at: null,
    });
    const audit = await pool.query(
      `SELECT actor_user_id, new_data ->> 'status' AS status FROM audit_log
       WHERE table_name = 'expenses' AND row_id = $1 ORDER BY id`,
      [id],
    );
    expect(audit.rows).toEqual([
      { actor_user_id: org.users.site_supervisor, status: 'draft' },
      { actor_user_id: org.users.site_supervisor, status: 'submitted' },
      { actor_user_id: org.users.project_manager, status: 'approved' },
    ]);
  });

  it('needs a reason to reject, and lets the creator reopen and fix a rejected expense', async () => {
    const org = await newOrg();
    const projectId = await createProject(org);
    const id = randomUUID();
    const { worker, project_manager: pm } = org.tokens;
    const patch = (data: object) => [{ op: 'PATCH', table: 'expenses', id, data }];
    await upload(
      [
        {
          op: 'PUT',
          table: 'expenses',
          id,
          data: {
            project_id: projectId,
            category: 'labour',
            description: 'Day rates',
            incurred_on: '2026-09-21',
            amount_minor: 5000,
            amount_currency: 'USD',
            fx_rate: '1',
            fx_rate_date: '2026-09-21',
            fx_rate_source: 'same_currency',
            base_amount_minor: 5000,
            base_amount_currency: 'USD',
          },
        },
        { op: 'PATCH', table: 'expenses', id, data: { status: 'submitted' } },
      ],
      worker,
    );
    expect((await upload(patch({ status: 'rejected' }), pm)).statusCode).toBe(422);
    expect(
      (await upload(patch({ status: 'rejected', rejection_reason: 'No timesheet' }), pm))
        .statusCode,
    ).toBe(200);
    expect((await upload(patch({ status: 'draft' }), worker)).statusCode).toBe(200);
    expect((await upload(patch({ description: 'Day rates, week 38' }), worker)).statusCode).toBe(
      200,
    );
    expect((await upload([{ op: 'DELETE', table: 'expenses', id }], worker)).statusCode).toBe(200);
    const { rows } = await pool.query(
      'SELECT description, deleted_at FROM expenses WHERE id = $1',
      [id],
    );
    expect(rows[0].description).toBe('Day rates, week 38');
    expect(rows[0].deleted_at).not.toBeNull();
  });
});

describe('POST /auth/dev-token', () => {
  it('signs in as a users row that owns an organisation', async () => {
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
    const memberships = await pool.query('SELECT role FROM memberships WHERE user_id = $1', [
      rows[0].id,
    ]);
    expect(memberships.rows).toEqual([{ role: 'owner' }]);
  });
});

describe('GET /health', () => {
  it('reports the database is reachable', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
