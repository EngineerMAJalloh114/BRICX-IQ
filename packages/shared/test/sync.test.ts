import { describe, expect, it } from 'vitest';

import { projectWriteSchema, uploadBatchSchema } from '../src';

describe('sync validation', () => {
  it('accepts a valid project write', () => {
    const result = projectWriteSchema.safeParse({
      name: 'Freetown Tower',
      currency: 'SLE',
      budget_minor: 1_000_000,
      status: 'planning',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown currencies and fractional minor amounts', () => {
    const base = { name: 'X', status: 'active' };
    expect(
      projectWriteSchema.safeParse({ ...base, currency: 'ZZZ', budget_minor: 1 }).success,
    ).toBe(false);
    expect(
      projectWriteSchema.safeParse({ ...base, currency: 'USD', budget_minor: 1.5 }).success,
    ).toBe(false);
  });

  it('rejects writes to tables that do not sync', () => {
    const result = uploadBatchSchema.safeParse({
      operations: [{ op: 'PUT', table: 'audit_log', id: crypto.randomUUID(), data: {} }],
    });
    expect(result.success).toBe(false);
  });
});
