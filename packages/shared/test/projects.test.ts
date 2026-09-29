import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { EXPENSE_STATUSES } from '../src/expenses';
import { t } from '../src/i18n';
import { parseMoney } from '../src/money';
import {
  COST_CATEGORIES,
  PROJECT_STATUSES,
  budgetLineFromRow,
  validateBudgetLine,
  validateProject,
  type Project,
} from '../src/projects';

const project: Project = {
  id: 'p1',
  organisationId: 'org1',
  code: 'BX-001',
  name: 'Clinic',
  currency: 'USD',
  status: 'active',
};

describe('projects', () => {
  it('accepts a valid project and explains what is wrong with a bad one', () => {
    expect(validateProject(project)).toEqual([]);
    expect(
      validateProject({
        ...project,
        name: ' ',
        currency: 'usd',
        startDate: '2026-09-01',
        endDate: '2026-08-01',
      }),
    ).toEqual([
      { field: 'name', key: 'required' },
      { field: 'currency', key: 'invalidCurrency' },
      { field: 'endDate', key: 'endBeforeStart' },
    ]);
    expect(validateProject({ ...project, startDate: '2026-13-45' })).toEqual([
      { field: 'startDate', key: 'invalidDate' },
    ]);
  });

  it('keeps budget lines in the project currency', () => {
    const base = { category: 'materials' as const, description: 'Cement' };
    expect(validateBudgetLine(project, { ...base, amount: parseMoney('100.00', 'USD') })).toEqual(
      [],
    );
    expect(validateBudgetLine(project, { ...base, amount: parseMoney('100.00', 'EUR') })).toEqual([
      { field: 'amount', key: 'budgetCurrency', params: { currency: 'USD' } },
    ]);
  });

  it('reads budget lines from device and database rows', () => {
    const line = budgetLineFromRow({
      id: 'l1',
      organisation_id: 'org1',
      project_id: 'p1',
      category: 'labour',
      description: 'Masons',
      amount_minor: '500000',
      amount_currency: 'USD',
    });
    expect(line.amount).toEqual(parseMoney('5000.00', 'USD'));
  });
});

describe('matches the database and translations', () => {
  const sql = readFileSync(
    new URL('../../../apps/api/migrations/0003_projects_budget_expenses.sql', import.meta.url),
    'utf8',
  );
  const checkValues = (pattern: RegExp) => {
    const m = pattern.exec(sql);
    return [...m![1]!.matchAll(/'(\w+)'/g)].map((v) => v[1]);
  };

  it('uses the same statuses and categories as the database', () => {
    expect(checkValues(/projects_status_check\s+CHECK \(status IN \(([^)]*)\)/)).toEqual([
      ...PROJECT_STATUSES,
    ]);
    expect(checkValues(/category\s+TEXT NOT NULL CHECK \(category IN\s+\(([^)]*)\)/)).toEqual([
      ...COST_CATEGORIES,
    ]);
    expect(
      checkValues(/status\s+TEXT NOT NULL DEFAULT 'draft'\s+CHECK \(status IN \(([^)]*)\)/),
    ).toEqual([...EXPENSE_STATUSES]);
  });

  it('has a label for every status and category', () => {
    for (const s of PROJECT_STATUSES) expect(t('en', `projects.status.${s}`)).toBeTruthy();
    for (const c of COST_CATEGORIES) expect(t('en', `budget.category.${c}`)).toBeTruthy();
    for (const s of EXPENSE_STATUSES) expect(t('en', `expenses.status.${s}`)).toBeTruthy();
  });
});
