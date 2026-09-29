import { describe, expect, it } from 'vitest';
import { summarizeBudget } from '../src/budget';
import type { Expense } from '../src/expenses';
import { parseMoney, toDecimalString } from '../src/money';
import type { BudgetLine, Project } from '../src/projects';

const project: Project = {
  id: 'p1',
  organisationId: 'org1',
  code: 'BX-001',
  name: 'Clinic',
  currency: 'USD',
  status: 'active',
};

const line = (id: string, amount: string, extra: Partial<BudgetLine> = {}): BudgetLine => ({
  id,
  organisationId: 'org1',
  projectId: 'p1',
  category: 'materials',
  description: id,
  amount: parseMoney(amount, 'USD'),
  ...extra,
});

const expense = (
  id: string,
  base: string,
  status: Expense['status'],
  extra: Partial<Expense> = {},
): Expense => ({
  id,
  organisationId: 'org1',
  projectId: 'p1',
  budgetLineId: 'cement',
  category: 'materials',
  description: id,
  incurredOn: '2026-07-01',
  amount: parseMoney(base, 'USD'),
  fx: { rate: '1', rateDate: '2026-07-01', source: 'same_currency' },
  baseAmount: parseMoney(base, 'USD'),
  status,
  createdBy: 'u1',
  ...extra,
});

describe('budget against actual', () => {
  const summary = summarizeBudget(
    project,
    [
      line('cement', '10000.00'),
      line('masons', '5000.00', { category: 'labour' }),
      line('old', '999.00', { deletedAt: 'x' }),
    ],
    [
      expense('a', '7500.00', 'approved'),
      expense('b', '3000.00', 'submitted'),
      expense('c', '400.00', 'draft'),
      expense('d', '100.00', 'rejected'),
      expense('e', '250.00', 'approved', { budgetLineId: null }),
      expense('f', '999.00', 'approved', { deletedAt: 'x' }),
      expense('g', '123.00', 'approved', { projectId: 'other' }),
    ],
  );

  it('counts only approved and submitted spend on live rows of this project', () => {
    const cement = summary.lines.find((l) => l.lineId === 'cement')!;
    expect(toDecimalString(cement.approved)).toBe('7500.00');
    expect(toDecimalString(cement.pending)).toBe('3000.00');
    expect(toDecimalString(cement.remaining)).toBe('2500.00');
    expect(cement.usedBasisPoints).toBe(7500);
    expect(cement.overBudget).toBe(true);

    const masons = summary.lines.find((l) => l.lineId === 'masons')!;
    expect(masons.usedBasisPoints).toBe(0);
    expect(masons.overBudget).toBe(false);
    expect(summary.lines.map((l) => l.lineId)).toEqual(['cement', 'masons']);
  });

  it('totals across lines, including spend not booked to a line', () => {
    expect(toDecimalString(summary.unallocated.approved)).toBe('250.00');
    expect(toDecimalString(summary.total.budget)).toBe('15000.00');
    expect(toDecimalString(summary.total.approved)).toBe('7750.00');
    expect(toDecimalString(summary.total.pending)).toBe('3000.00');
    expect(toDecimalString(summary.total.remaining)).toBe('7250.00');
    expect(summary.total.overBudget).toBe(false);
    expect(summary.currency).toBe('USD');
  });

  it('handles a project with no budget yet', () => {
    const empty = summarizeBudget(
      project,
      [],
      [expense('a', '10.00', 'approved', { budgetLineId: null })],
    );
    expect(empty.total.usedBasisPoints).toBeNull();
    expect(empty.total.overBudget).toBe(true);
    expect(toDecimalString(empty.total.remaining)).toBe('-10.00');
  });

  it('refuses a base amount in the wrong currency', () => {
    expect(() =>
      summarizeBudget(
        project,
        [],
        [expense('a', '10.00', 'approved', { baseAmount: parseMoney('10.00', 'EUR') })],
      ),
    ).toThrow(/Currency mismatch/);
  });
});
