import { describe, expect, it } from 'vitest';

import { expenseWriteSchema, projectWriteSchema, uploadBatchSchema } from '../src';

const org = crypto.randomUUID();

describe('sync validation', () => {
  it('accepts a valid project write', () => {
    const result = projectWriteSchema.safeParse({
      organisation_id: org,
      name: 'Freetown Tower',
      currency: 'SLE',
      status: 'planning',
      start_date: '2026-10-01',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown currencies, statuses and dates', () => {
    const base = { organisation_id: org, name: 'X', currency: 'USD', status: 'active' };
    expect(projectWriteSchema.safeParse({ ...base, currency: 'ZZZ' }).success).toBe(false);
    expect(projectWriteSchema.safeParse({ ...base, status: 'abandoned' }).success).toBe(false);
    expect(projectWriteSchema.safeParse({ ...base, end_date: '2026-02-30' }).success).toBe(false);
  });

  it('keeps expense amounts as integers and rates as decimal strings', () => {
    const expense = {
      project_id: crypto.randomUUID(),
      category: 'materials',
      description: 'Cement',
      incurred_on: '2026-07-15',
      amount_minor: 462000,
      amount_currency: 'SLE',
      fx_rate: '0.04329004329',
      fx_rate_date: '2026-06-01',
      fx_rate_source: 'global',
      base_amount_minor: 20000,
      base_amount_currency: 'USD',
    };
    expect(expenseWriteSchema.safeParse(expense).success).toBe(true);
    expect(expenseWriteSchema.safeParse({ ...expense, amount_minor: 1.5 }).success).toBe(false);
    expect(expenseWriteSchema.safeParse({ ...expense, amount_minor: 0 }).success).toBe(false);
    expect(expenseWriteSchema.safeParse({ ...expense, fx_rate: 0.0433 }).success).toBe(false);
    expect(expenseWriteSchema.safeParse({ ...expense, fx_rate: '-1' }).success).toBe(false);
  });

  it('rejects writes to tables that do not sync or only sync down', () => {
    for (const table of ['audit_log', 'memberships', 'exchange_rates']) {
      const result = uploadBatchSchema.safeParse({
        operations: [{ op: 'PUT', table, id: crypto.randomUUID(), data: {} }],
      });
      expect(result.success, table).toBe(false);
    }
  });
});
