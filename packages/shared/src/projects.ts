/**
 * Projects and budget lines. Mirrors apps/api/migrations/0003_projects_budget_expenses.sql.
 */
import { assertIsoDate } from './exchange-rates';
import { isCurrencyCode, money, type CurrencyCode, type Money } from './money';

// Keep in sync with projects_status_check in the database.
export const PROJECT_STATUSES = [
  'planning',
  'active',
  'on_hold',
  'completed',
  'cancelled',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

// Keep in sync with the category checks in the database.
export const COST_CATEGORIES = [
  'labour',
  'materials',
  'equipment',
  'subcontract',
  'overhead',
  'contingency',
  'other',
] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

/**
 * Every synced row has a UUID generated on the device, so records can be
 * created offline, and is soft-deleted through `deletedAt`.
 */
export interface RecordMeta {
  readonly id: string;
  readonly organisationId: string;
  readonly deletedAt?: string | null;
}

export interface Project extends RecordMeta {
  readonly code?: string | null;
  readonly name: string;
  readonly clientName?: string | null;
  readonly location?: string | null;
  /** Budgets and spending are reported in this currency. */
  readonly currency: CurrencyCode;
  readonly status: ProjectStatus;
  /** ISO dates, YYYY-MM-DD. */
  readonly startDate?: string | null;
  readonly endDate?: string | null;
}

export interface BudgetLine extends RecordMeta {
  readonly projectId: string;
  readonly category: CostCategory;
  readonly description: string;
  /** Always in the project's currency. */
  readonly amount: Money;
}

/** A validation problem, as a translation key under `errors.` plus params. */
export interface FieldError {
  readonly field: string;
  readonly key: string;
  readonly params?: Record<string, string | number>;
}

export class ValidationError extends Error {
  constructor(readonly errors: readonly FieldError[]) {
    super(`Invalid input: ${errors.map((e) => `${e.field} (${e.key})`).join(', ')}`);
    this.name = 'ValidationError';
  }
}

function isBlank(s: string | null | undefined): boolean {
  return s === undefined || s === null || s.trim().length === 0;
}

export function isIsoDate(date: string): boolean {
  try {
    assertIsoDate(date);
    return true;
  } catch {
    return false;
  }
}

export type ProjectInput = Pick<
  Project,
  'code' | 'name' | 'clientName' | 'location' | 'currency' | 'status' | 'startDate' | 'endDate'
>;

export function validateProject(input: ProjectInput): FieldError[] {
  const errors: FieldError[] = [];
  if (isBlank(input.name)) errors.push({ field: 'name', key: 'required' });
  if (!isCurrencyCode(input.currency)) errors.push({ field: 'currency', key: 'invalidCurrency' });
  if (!PROJECT_STATUSES.includes(input.status)) errors.push({ field: 'status', key: 'invalid' });
  const start = input.startDate ?? null;
  const end = input.endDate ?? null;
  if (start !== null && !isIsoDate(start)) errors.push({ field: 'startDate', key: 'invalidDate' });
  if (end !== null && !isIsoDate(end)) errors.push({ field: 'endDate', key: 'invalidDate' });
  if (start && end && isIsoDate(start) && isIsoDate(end) && end < start) {
    errors.push({ field: 'endDate', key: 'endBeforeStart' });
  }
  return errors;
}

export type BudgetLineInput = Pick<BudgetLine, 'category' | 'description' | 'amount'>;

export function validateBudgetLine(project: Project, input: BudgetLineInput): FieldError[] {
  const errors: FieldError[] = [];
  if (!COST_CATEGORIES.includes(input.category)) errors.push({ field: 'category', key: 'invalid' });
  if (isBlank(input.description)) errors.push({ field: 'description', key: 'required' });
  if (input.amount.currency !== project.currency) {
    errors.push({ field: 'amount', key: 'budgetCurrency', params: { currency: project.currency } });
  }
  if (input.amount.amountMinor < 0n) errors.push({ field: 'amount', key: 'negative' });
  return errors;
}

/** A projects row as stored on the device (SQLite) or returned by pg. */
export interface ProjectRow {
  id: string;
  organisation_id: string | null;
  code: string | null;
  name: string | null;
  client_name: string | null;
  location: string | null;
  currency: string | null;
  status: string | null;
  start_date: string | null;
  end_date: string | null;
  deleted_at?: string | null;
}

export function projectFromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    organisationId: row.organisation_id ?? '',
    code: row.code,
    name: row.name ?? '',
    clientName: row.client_name,
    location: row.location,
    currency: row.currency ?? '',
    status: (row.status ?? 'planning') as ProjectStatus,
    startDate: row.start_date,
    endDate: row.end_date,
    deletedAt: row.deleted_at ?? null,
  };
}

export interface BudgetLineRow {
  id: string;
  organisation_id: string | null;
  project_id: string | null;
  category: string | null;
  description: string | null;
  amount_minor: number | string | null;
  amount_currency: string | null;
  deleted_at?: string | null;
}

export function budgetLineFromRow(row: BudgetLineRow): BudgetLine {
  return {
    id: row.id,
    organisationId: row.organisation_id ?? '',
    projectId: row.project_id ?? '',
    category: (row.category ?? 'other') as CostCategory,
    description: row.description ?? '',
    amount: money(BigInt(row.amount_minor ?? 0), row.amount_currency ?? ''),
    deletedAt: row.deleted_at ?? null,
  };
}
