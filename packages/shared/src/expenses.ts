/**
 * Expenses: entry in any currency with the exchange rate locked at entry time,
 * and the draft -> submitted -> approved / rejected workflow.
 * The database enforces the same rules (apps/api/migrations/0003_projects_budget_expenses.sql);
 * this module lets the app check them offline and the API check permissions.
 */
import { assertIsoDate, convert, validateRate, type ExchangeRate } from './exchange-rates';
import { divRoundHalfEven, money, parseDecimal, type Money } from './money';
import { assertCan, can, type Role } from './permissions';
import {
  COST_CATEGORIES,
  ValidationError,
  isIsoDate,
  type CostCategory,
  type FieldError,
  type Project,
  type RecordMeta,
} from './projects';

// Keep in sync with the expenses status check in the database.
export const EXPENSE_STATUSES = ['draft', 'submitted', 'approved', 'rejected'] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

/** Where the locked rate came from. Matches the fx_rate_source column. */
export const RATE_SOURCES = ['same_currency', 'organisation', 'global', 'manual'] as const;
export type RateSource = (typeof RATE_SOURCES)[number];

/** Stored rates have 12 decimal places (NUMERIC(24, 12)). */
export const RATE_SCALE = 12;

export interface LockedRate {
  /** 1 unit of the expense currency = `rate` units of the project currency. */
  readonly rate: string;
  /** Effective date of the rate used. */
  readonly rateDate: string;
  readonly source: RateSource;
  readonly manualReason?: string | null;
}

/** The fields that decide who may do what with an expense. */
export interface ExpenseState {
  readonly status: ExpenseStatus;
  readonly createdBy: string;
  readonly submittedBy?: string | null;
  readonly deletedAt?: string | null;
}

export interface Expense extends RecordMeta, ExpenseState {
  readonly projectId: string;
  readonly budgetLineId?: string | null;
  readonly category: CostCategory;
  readonly description: string;
  readonly vendor?: string | null;
  readonly incurredOn: string;
  /** As paid, in any currency. */
  readonly amount: Money;
  readonly fx: LockedRate;
  /** `amount` converted to the project's currency at `fx.rate`. */
  readonly baseAmount: Money;
  readonly decidedBy?: string | null;
  readonly rejectionReason?: string | null;
}

export interface ExpenseInput {
  readonly projectId: string;
  readonly budgetLineId?: string | null;
  readonly category: CostCategory;
  readonly description: string;
  readonly vendor?: string | null;
  readonly incurredOn: string;
  readonly amount: Money;
  /** Set to override the looked-up rate; a reason is then required. */
  readonly manualRate?: { readonly rate: string; readonly reason: string };
}

/** Rates the device has cached, split by who published them. */
export interface RateBook {
  readonly organisation: readonly ExchangeRate[];
  readonly global: readonly ExchangeRate[];
}

function pairKey(r: ExchangeRate): string {
  const [a, b] = [r.base, r.quote].sort();
  return `${a}/${b}/${r.effectiveDate}`;
}

/** Render units / 10^scale as a decimal string without trailing zeros. */
function decimalString(units: bigint, scale: number): string {
  const neg = units < 0n;
  const digits = (neg ? -units : units).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale).replace(/0+$/, '');
  return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
}

/** Round a positive decimal string to RATE_SCALE places, half-to-even. */
function toStoredRate(rate: string): string {
  const d = parseDecimal(rate);
  if (d.scale <= RATE_SCALE) return decimalString(d.units, d.scale);
  return decimalString(divRoundHalfEven(d.units, 10n ** BigInt(d.scale - RATE_SCALE)), RATE_SCALE);
}

/** 1 / rate, to RATE_SCALE places. */
function invertRate(rate: string): string {
  const d = parseDecimal(rate);
  return decimalString(divRoundHalfEven(10n ** BigInt(RATE_SCALE + d.scale), d.units), RATE_SCALE);
}

/**
 * Pick the rate in force on `date` from the device's cached rates, preferring
 * the organisation's own over a global rate on the same date (the same rule
 * as exchange_rate_on() in SQL), and express it as stored: expense currency to
 * project currency, 12 decimal places.
 */
export function lockRate(
  amount: Money,
  projectCurrency: string,
  date: string,
  rates: RateBook,
  manual?: { rate: string; reason: string },
): LockedRate {
  assertIsoDate(date);
  if (amount.currency === projectCurrency) {
    return { rate: '1', rateDate: date, source: 'same_currency' };
  }
  if (manual) {
    if (manual.reason.trim().length === 0) {
      throw new ValidationError([{ field: 'manualRate', key: 'manualRateReason' }]);
    }
    let r: ExchangeRate;
    try {
      r = validateRate({
        base: amount.currency,
        quote: projectCurrency,
        rate: manual.rate,
        effectiveDate: date,
      });
    } catch {
      throw new ValidationError([{ field: 'manualRate', key: 'invalid' }]);
    }
    return {
      rate: toStoredRate(r.rate),
      rateDate: date,
      source: 'manual',
      manualReason: manual.reason.trim(),
    };
  }
  const orgKeys = new Set(rates.organisation.map(pairKey));
  const candidates = [
    ...rates.organisation,
    ...rates.global.filter((r) => !orgKeys.has(pairKey(r))),
  ];
  let used: ExchangeRate;
  try {
    used = convert(amount, projectCurrency, date, candidates).rate;
  } catch {
    throw new ValidationError([
      {
        field: 'amount',
        key: 'noExchangeRate',
        params: { from: amount.currency, to: projectCurrency, date },
      },
    ]);
  }
  const direct = used.base === amount.currency;
  return {
    rate: direct ? toStoredRate(used.rate) : invertRate(used.rate),
    rateDate: used.effectiveDate,
    source: rates.organisation.includes(used) ? 'organisation' : 'global',
  };
}

/** Convert at a locked rate, exactly as the database checks it. */
export function applyLockedRate(amount: Money, projectCurrency: string, fx: LockedRate): Money {
  return convert(amount, projectCurrency, fx.rateDate, [
    { base: amount.currency, quote: projectCurrency, rate: fx.rate, effectiveDate: fx.rateDate },
  ]).money;
}

export function validateExpense(project: Project, input: ExpenseInput): FieldError[] {
  const errors: FieldError[] = [];
  if (input.projectId !== project.id) errors.push({ field: 'projectId', key: 'invalid' });
  if (!COST_CATEGORIES.includes(input.category)) errors.push({ field: 'category', key: 'invalid' });
  if (input.description.trim().length === 0) errors.push({ field: 'description', key: 'required' });
  if (input.amount.amountMinor <= 0n) errors.push({ field: 'amount', key: 'positive' });
  if (!isIsoDate(input.incurredOn)) errors.push({ field: 'incurredOn', key: 'invalidDate' });
  return errors;
}

export interface ExpenseActor {
  readonly userId: string;
  readonly role: Role;
}

/**
 * Build a new draft expense on the device, converting to the project's
 * currency at the rate in force on the day it was paid.
 */
export function createExpenseDraft(
  actor: ExpenseActor,
  project: Project,
  input: ExpenseInput,
  rates: RateBook,
  id: string,
): Expense {
  assertCan(actor.role, 'expenses.create');
  const errors = validateExpense(project, input);
  if (errors.length) throw new ValidationError(errors);
  const fx = lockRate(input.amount, project.currency, input.incurredOn, rates, input.manualRate);
  return {
    id,
    organisationId: project.organisationId,
    projectId: project.id,
    budgetLineId: input.budgetLineId ?? null,
    category: input.category,
    description: input.description.trim(),
    vendor: input.vendor ?? null,
    incurredOn: input.incurredOn,
    amount: input.amount,
    fx,
    baseAmount: applyLockedRate(input.amount, project.currency, fx),
    status: 'draft',
    createdBy: actor.userId,
  };
}

export type ExpenseAction =
  'edit' | 'delete' | 'submit' | 'withdraw' | 'approve' | 'reject' | 'reopen';

const NEXT_STATUS: Record<ExpenseAction, { from: ExpenseStatus[]; to: ExpenseStatus }> = {
  edit: { from: ['draft'], to: 'draft' },
  delete: { from: ['draft'], to: 'draft' },
  submit: { from: ['draft'], to: 'submitted' },
  withdraw: { from: ['submitted'], to: 'draft' },
  approve: { from: ['submitted'], to: 'approved' },
  reject: { from: ['submitted'], to: 'rejected' },
  reopen: { from: ['rejected'], to: 'draft' },
};

/** The workflow action that moves an expense from one status to another. */
export function actionForStatusChange(
  from: ExpenseStatus,
  to: ExpenseStatus,
): ExpenseAction | null {
  for (const [action, rule] of Object.entries(NEXT_STATUS) as [
    ExpenseAction,
    (typeof NEXT_STATUS)[ExpenseAction],
  ][]) {
    if (action !== 'edit' && action !== 'delete' && rule.from.includes(from) && rule.to === to) {
      return action;
    }
  }
  return null;
}

export type Denial =
  | { readonly reason: 'wrong_status'; readonly status: ExpenseStatus }
  | { readonly reason: 'forbidden' }
  | { readonly reason: 'own_expense' };

/**
 * Whether `actor` may take `action` on `expense`, and why not. Used by the
 * screens to show or hide buttons and by the API before writing.
 */
export function checkExpenseAction(
  actor: ExpenseActor,
  expense: ExpenseState,
  action: ExpenseAction,
): Denial | null {
  if (expense.deletedAt) return { reason: 'wrong_status', status: expense.status };
  if (!NEXT_STATUS[action].from.includes(expense.status)) {
    return { reason: 'wrong_status', status: expense.status };
  }
  switch (action) {
    case 'approve':
    case 'reject':
      if (!can(actor.role, 'expenses.approve')) return { reason: 'forbidden' };
      // Segregation of duties: nobody decides on their own claim.
      if (expense.submittedBy === actor.userId) return { reason: 'own_expense' };
      return null;
    case 'withdraw':
      return expense.submittedBy === actor.userId ? null : { reason: 'forbidden' };
    default:
      // Drafts belong to whoever entered them; approvers may tidy them up too.
      if (!can(actor.role, 'expenses.create')) return { reason: 'forbidden' };
      if (expense.createdBy !== actor.userId && !can(actor.role, 'expenses.approve')) {
        return { reason: 'forbidden' };
      }
      return null;
  }
}

export class ExpenseActionError extends Error {
  constructor(
    readonly action: ExpenseAction,
    readonly denial: Denial,
  ) {
    super(`Cannot ${action} expense: ${denial.reason}`);
    this.name = 'ExpenseActionError';
  }
}

/**
 * Apply a status change locally, stamping the same fields the database trigger
 * stamps. The server re-checks everything when the change syncs.
 */
export function transitionExpense(
  actor: ExpenseActor,
  expense: Expense,
  action: Exclude<ExpenseAction, 'edit' | 'delete'>,
  rejectionReason?: string,
): Expense {
  const denial = checkExpenseAction(actor, expense, action);
  if (denial) throw new ExpenseActionError(action, denial);
  const to = NEXT_STATUS[action].to;
  switch (to) {
    case 'submitted':
      return {
        ...expense,
        status: to,
        submittedBy: actor.userId,
        decidedBy: null,
        rejectionReason: null,
      };
    case 'approved':
      return { ...expense, status: to, decidedBy: actor.userId, rejectionReason: null };
    case 'rejected':
      if (!rejectionReason || rejectionReason.trim().length === 0) {
        throw new ValidationError([{ field: 'rejectionReason', key: 'required' }]);
      }
      return {
        ...expense,
        status: to,
        decidedBy: actor.userId,
        rejectionReason: rejectionReason.trim(),
      };
    case 'draft':
      return { ...expense, status: to, submittedBy: null };
  }
}

/**
 * Edit a draft. Changing the amount, currency or date locks a fresh rate;
 * otherwise the original rate stays, so re-saving never moves the numbers.
 */
export function editExpenseDraft(
  actor: ExpenseActor,
  project: Project,
  expense: Expense,
  input: ExpenseInput,
  rates: RateBook,
): Expense {
  const denial = checkExpenseAction(actor, expense, 'edit');
  if (denial) throw new ExpenseActionError('edit', denial);
  const errors = validateExpense(project, input);
  if (errors.length) throw new ValidationError(errors);
  const moneyChanged =
    input.amount.amountMinor !== expense.amount.amountMinor ||
    input.amount.currency !== expense.amount.currency ||
    input.incurredOn !== expense.incurredOn ||
    input.manualRate !== undefined;
  const fx = moneyChanged
    ? lockRate(input.amount, project.currency, input.incurredOn, rates, input.manualRate)
    : expense.fx;
  return {
    ...expense,
    budgetLineId: input.budgetLineId ?? null,
    category: input.category,
    description: input.description.trim(),
    vendor: input.vendor ?? null,
    incurredOn: input.incurredOn,
    amount: input.amount,
    fx,
    baseAmount: applyLockedRate(input.amount, project.currency, fx),
  };
}

/** An expenses row as stored on the device (SQLite) or returned by pg. */
export interface ExpenseRow {
  id: string;
  organisation_id: string | null;
  project_id: string | null;
  budget_line_id: string | null;
  category: string | null;
  description: string | null;
  vendor: string | null;
  incurred_on: string | null;
  amount_minor: number | string | null;
  amount_currency: string | null;
  fx_rate: string | number | null;
  fx_rate_date: string | null;
  fx_rate_source: string | null;
  fx_manual_reason: string | null;
  base_amount_minor: number | string | null;
  base_amount_currency: string | null;
  status: string | null;
  submitted_by: string | null;
  decided_by: string | null;
  rejection_reason: string | null;
  created_by: string | null;
  deleted_at?: string | null;
}

/** Postgres returns dates as Date and NUMERIC as "0.043290043290"; normalise both. */
function isoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? '').slice(0, 10);
}

export function expenseFromRow(row: ExpenseRow): Expense {
  return {
    id: row.id,
    organisationId: row.organisation_id ?? '',
    projectId: row.project_id ?? '',
    budgetLineId: row.budget_line_id,
    category: (row.category ?? 'other') as CostCategory,
    description: row.description ?? '',
    vendor: row.vendor,
    incurredOn: isoDate(row.incurred_on),
    amount: money(BigInt(row.amount_minor ?? 0), row.amount_currency ?? ''),
    fx: {
      rate: toStoredRate(String(row.fx_rate ?? '1')),
      rateDate: isoDate(row.fx_rate_date),
      source: (row.fx_rate_source ?? 'same_currency') as RateSource,
      manualReason: row.fx_manual_reason,
    },
    baseAmount: money(BigInt(row.base_amount_minor ?? 0), row.base_amount_currency ?? ''),
    status: (row.status ?? 'draft') as ExpenseStatus,
    createdBy: row.created_by ?? '',
    submittedBy: row.submitted_by,
    decidedBy: row.decided_by,
    rejectionReason: row.rejection_reason,
    deletedAt: row.deleted_at ?? null,
  };
}

/** The columns a device writes for an expense's content (see expenseWriteSchema). */
export function expenseContentColumns(e: Expense) {
  return {
    project_id: e.projectId,
    budget_line_id: e.budgetLineId ?? null,
    category: e.category,
    description: e.description,
    vendor: e.vendor ?? null,
    incurred_on: e.incurredOn,
    amount_minor: Number(e.amount.amountMinor),
    amount_currency: e.amount.currency,
    fx_rate: e.fx.rate,
    fx_rate_date: e.fx.rateDate,
    fx_rate_source: e.fx.source,
    fx_manual_reason: e.fx.manualReason ?? null,
    base_amount_minor: Number(e.baseAmount.amountMinor),
    base_amount_currency: e.baseAmount.currency,
  };
}

/** Exchange-rate rows synced to the device, split into a RateBook. */
export interface ExchangeRateRow {
  organisation_id: string | null;
  base_currency: string | null;
  quote_currency: string | null;
  rate: string | number | null;
  effective_date: string | null;
}

export function rateBookFromRows(rows: readonly ExchangeRateRow[]): RateBook {
  const organisation: ExchangeRate[] = [];
  const global: ExchangeRate[] = [];
  for (const row of rows) {
    if (!row.base_currency || !row.quote_currency || row.rate === null || !row.effective_date) {
      continue;
    }
    const rate: ExchangeRate = {
      base: row.base_currency,
      quote: row.quote_currency,
      rate: toStoredRate(String(row.rate)),
      effectiveDate: isoDate(row.effective_date),
    };
    (row.organisation_id ? organisation : global).push(rate);
  }
  return { organisation, global };
}
