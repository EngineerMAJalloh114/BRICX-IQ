import {
  ExpenseActionError,
  ValidationError,
  budgetLineFromRow,
  expenseFromRow,
  isRole,
  projectFromRow,
  rateBookFromRows,
  type BudgetLine,
  type BudgetLineRow,
  type Expense,
  type ExpenseRow,
  type ExchangeRateRow,
  type Project,
  type ProjectRow,
  type RateBook,
  type Role,
} from '@bricx/shared';
import { useQuery } from '@powersync/react';
import { useEffect, useMemo, useState } from 'react';

import { t } from './i18n';
import { currentUserId } from './session';

/** Who is using the app, and their role in the organisation they work in. */
export interface Me {
  userId: string;
  organisationId: string;
  organisationCurrency: string;
  role: Role;
}

export function useMe(): Me | null {
  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => {
    currentUserId().then(setUserId);
  }, []);
  const { data } = useQuery<{ organisation_id: string; role: string; base_currency: string }>(
    `SELECT m.organisation_id, m.role, o.base_currency
     FROM memberships m JOIN organisations o ON o.id = m.organisation_id
     WHERE m.user_id = ? ORDER BY o.name LIMIT 1`,
    [userId ?? ''],
  );
  const row = data[0];
  if (!userId || !row || !isRole(row.role)) return null;
  return {
    userId,
    organisationId: row.organisation_id,
    organisationCurrency: row.base_currency,
    role: row.role,
  };
}

export function useProjects(): Project[] {
  const { data } = useQuery<ProjectRow>('SELECT * FROM projects ORDER BY created_at DESC');
  return useMemo(() => data.map(projectFromRow), [data]);
}

export interface ProjectData {
  project: Project | null;
  lines: BudgetLine[];
  expenses: Expense[];
}

export function useProjectData(projectId: string): ProjectData {
  const projects = useQuery<ProjectRow>('SELECT * FROM projects WHERE id = ?', [projectId]);
  const lines = useQuery<BudgetLineRow>(
    'SELECT * FROM budget_lines WHERE project_id = ? ORDER BY created_at',
    [projectId],
  );
  const expenses = useQuery<ExpenseRow>(
    'SELECT * FROM expenses WHERE project_id = ? ORDER BY incurred_on DESC, created_at DESC',
    [projectId],
  );
  return useMemo(
    () => ({
      project: projects.data[0] ? projectFromRow(projects.data[0]) : null,
      lines: lines.data.map(budgetLineFromRow),
      expenses: expenses.data.map(expenseFromRow),
    }),
    [projects.data, lines.data, expenses.data],
  );
}

/** Exchange rates synced to the device, for converting expenses offline. */
export function useRateBook(): RateBook {
  const { data } = useQuery<ExchangeRateRow>('SELECT * FROM exchange_rates');
  return useMemo(() => rateBookFromRows(data), [data]);
}

/** A user-facing message for an error from the shared rules. */
export function errorMessage(e: unknown): string {
  if (e instanceof ValidationError) {
    return e.errors.map((err) => t(`errors.${err.key}`, err.params)).join(' ');
  }
  if (e instanceof ExpenseActionError) {
    const d = e.denial;
    if (d.reason === 'own_expense') return t('errors.ownExpense');
    if (d.reason === 'wrong_status') {
      return t('errors.wrongStatus', { status: t(`expenses.status.${d.status}`) });
    }
    return t('errors.forbidden');
  }
  if (e instanceof Error && e.name === 'ForbiddenError') return t('errors.forbidden');
  return e instanceof Error ? e.message : String(e);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function newId(): string {
  return globalThis.crypto.randomUUID();
}
