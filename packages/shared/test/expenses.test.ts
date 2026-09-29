import { describe, expect, it } from 'vitest';
import type { ExchangeRate } from '../src/exchange-rates';
import {
  ExpenseActionError,
  applyLockedRate,
  checkExpenseAction,
  createExpenseDraft,
  editExpenseDraft,
  lockRate,
  transitionExpense,
  type Expense,
  type ExpenseActor,
  type ExpenseInput,
  type RateBook,
} from '../src/expenses';
import { money, parseMoney, toDecimalString } from '../src/money';
import { ForbiddenError } from '../src/permissions';
import { ValidationError, type Project } from '../src/projects';

const project: Project = {
  id: 'p1',
  organisationId: 'org1',
  code: 'BX-001',
  name: 'Lumley Road Clinic',
  currency: 'USD',
  status: 'active',
};

const globalRates: ExchangeRate[] = [
  { base: 'USD', quote: 'SLE', rate: '22.50', effectiveDate: '2026-01-01' },
  { base: 'USD', quote: 'SLE', rate: '23.10', effectiveDate: '2026-06-01' },
  { base: 'EUR', quote: 'USD', rate: '1.0850', effectiveDate: '2026-01-01' },
];
const orgRates: ExchangeRate[] = [
  { base: 'USD', quote: 'SLE', rate: '22.80', effectiveDate: '2026-01-01' },
];
const rates: RateBook = { organisation: orgRates, global: globalRates };

const site: ExpenseActor = { userId: 'u-site', role: 'site_supervisor' };
const pm: ExpenseActor = { userId: 'u-pm', role: 'project_manager' };
const worker: ExpenseActor = { userId: 'u-worker', role: 'worker' };
const viewer: ExpenseActor = { userId: 'u-view', role: 'viewer' };

const cementInLeones: ExpenseInput = {
  projectId: 'p1',
  category: 'materials',
  description: '  Cement, 20 bags  ',
  incurredOn: '2026-07-15',
  amount: parseMoney('4620.00', 'SLE'),
};

describe('locking the exchange rate', () => {
  it('uses no conversion for the project currency', () => {
    const fx = lockRate(parseMoney('10.00', 'USD'), 'USD', '2026-07-01', rates);
    expect(fx).toEqual({ rate: '1', rateDate: '2026-07-01', source: 'same_currency' });
  });

  it('inverts a base-currency quote to the rate stored on the expense', () => {
    // Only USD->SLE is published; the expense needs SLE->USD.
    const fx = lockRate(parseMoney('4620.00', 'SLE'), 'USD', '2026-07-15', {
      organisation: [],
      global: globalRates,
    });
    expect(fx).toEqual({ rate: '0.04329004329', rateDate: '2026-06-01', source: 'global' });
    expect(toDecimalString(applyLockedRate(parseMoney('4620.00', 'SLE'), 'USD', fx))).toBe(
      '200.00',
    );
  });

  it('uses a direct quote as is', () => {
    const fx = lockRate(parseMoney('100.00', 'EUR'), 'USD', '2026-02-01', rates);
    expect(fx).toEqual({ rate: '1.085', rateDate: '2026-01-01', source: 'global' });
  });

  it("prefers the organisation's rate on the same date, but a newer global rate wins", () => {
    expect(lockRate(parseMoney('1.00', 'SLE'), 'USD', '2026-03-01', rates).source).toBe(
      'organisation',
    );
    expect(lockRate(parseMoney('1.00', 'SLE'), 'USD', '2026-07-01', rates)).toMatchObject({
      source: 'global',
      rateDate: '2026-06-01',
    });
  });

  it('requires a reason for a rate entered by hand', () => {
    expect(() =>
      lockRate(parseMoney('1.00', 'SLE'), 'USD', '2026-07-01', rates, {
        rate: '0.05',
        reason: ' ',
      }),
    ).toThrow(ValidationError);
    expect(
      lockRate(parseMoney('1.00', 'SLE'), 'USD', '2026-07-01', rates, {
        rate: '0.05',
        reason: 'Bank receipt',
      }),
    ).toEqual({
      rate: '0.05',
      rateDate: '2026-07-01',
      source: 'manual',
      manualReason: 'Bank receipt',
    });
  });

  it('reports a missing rate as a validation error with the pair and date', () => {
    try {
      lockRate(parseMoney('1.00', 'GHS'), 'USD', '2026-07-01', rates);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).errors[0]).toEqual({
        field: 'amount',
        key: 'noExchangeRate',
        params: { from: 'GHS', to: 'USD', date: '2026-07-01' },
      });
    }
  });
});

describe('creating an expense', () => {
  it('keeps the original amount and stores the converted one', () => {
    const e = createExpenseDraft(site, project, cementInLeones, rates, 'e1');
    expect(e.status).toBe('draft');
    expect(e.description).toBe('Cement, 20 bags');
    expect(e.amount).toEqual(parseMoney('4620.00', 'SLE'));
    expect(e.baseAmount).toEqual(parseMoney('200.00', 'USD'));
    expect(e.fx.source).toBe('global');
    expect(e.createdBy).toBe('u-site');
  });

  it('refuses users without permission and invalid input', () => {
    expect(() => createExpenseDraft(viewer, project, cementInLeones, rates, 'e1')).toThrow(
      ForbiddenError,
    );
    expect(() =>
      createExpenseDraft(
        site,
        project,
        { ...cementInLeones, amount: money(0, 'SLE'), description: '' },
        rates,
        'e1',
      ),
    ).toThrow(
      /amount \(positive\), description \(required\)|description \(required\), amount \(positive\)/,
    );
  });
});

describe('expense workflow', () => {
  const draft = createExpenseDraft(site, project, cementInLeones, rates, 'e1');

  it('goes draft -> submitted -> approved', () => {
    const submitted = transitionExpense(site, draft, 'submit');
    expect(submitted.submittedBy).toBe('u-site');
    const approved = transitionExpense(pm, submitted, 'approve');
    expect(approved).toMatchObject({ status: 'approved', decidedBy: 'u-pm' });
    for (const action of ['edit', 'delete', 'withdraw', 'reject', 'reopen'] as const) {
      expect(checkExpenseAction(pm, approved, action)).toEqual({
        reason: 'wrong_status',
        status: 'approved',
      });
    }
  });

  it('does not let anyone decide on their own expense', () => {
    const own = createExpenseDraft(pm, project, cementInLeones, rates, 'e2');
    const submitted = transitionExpense(pm, own, 'submit');
    expect(checkExpenseAction(pm, submitted, 'approve')).toEqual({ reason: 'own_expense' });
    expect(() => transitionExpense(pm, submitted, 'approve')).toThrow(ExpenseActionError);
  });

  it('only lets approvers approve', () => {
    const submitted = transitionExpense(site, draft, 'submit');
    expect(checkExpenseAction(worker, submitted, 'approve')).toEqual({ reason: 'forbidden' });
    expect(
      checkExpenseAction({ userId: 'u-fin', role: 'finance' }, submitted, 'approve'),
    ).toBeNull();
  });

  it('needs a reason to reject, and a rejected expense can be reopened and fixed', () => {
    const submitted = transitionExpense(site, draft, 'submit');
    expect(() => transitionExpense(pm, submitted, 'reject', '')).toThrow(ValidationError);
    const rejected = transitionExpense(pm, submitted, 'reject', 'No receipt');
    expect(rejected.rejectionReason).toBe('No receipt');
    expect(checkExpenseAction(site, rejected, 'edit')).toEqual({
      reason: 'wrong_status',
      status: 'rejected',
    });
    const reopened = transitionExpense(site, rejected, 'reopen');
    expect(reopened).toMatchObject({ status: 'draft', submittedBy: null });
    expect(checkExpenseAction(site, reopened, 'edit')).toBeNull();
  });

  it('lets only the submitter withdraw', () => {
    const submitted = transitionExpense(site, draft, 'submit');
    expect(checkExpenseAction(pm, submitted, 'withdraw')).toEqual({ reason: 'forbidden' });
    expect(transitionExpense(site, submitted, 'withdraw').status).toBe('draft');
  });

  it("keeps other people's drafts out of reach of workers", () => {
    expect(checkExpenseAction(worker, draft, 'edit')).toEqual({ reason: 'forbidden' });
    expect(checkExpenseAction(pm, draft, 'edit')).toBeNull();
    expect(
      checkExpenseAction(site, { ...draft, deletedAt: '2026-07-16T00:00:00Z' }, 'edit'),
    ).not.toBeNull();
  });
});

describe('editing a draft', () => {
  const draft: Expense = createExpenseDraft(site, project, cementInLeones, rates, 'e1');

  it('keeps the locked rate when the money did not change', () => {
    // A newer rate has appeared since the expense was entered.
    const later: RateBook = {
      organisation: [],
      global: [
        ...globalRates,
        { base: 'USD', quote: 'SLE', rate: '25', effectiveDate: '2026-07-01' },
      ],
    };
    const edited = editExpenseDraft(
      site,
      project,
      draft,
      { ...cementInLeones, vendor: 'Leocem' },
      later,
    );
    expect(edited.fx).toEqual(draft.fx);
    expect(edited.baseAmount).toEqual(draft.baseAmount);
    expect(edited.vendor).toBe('Leocem');
  });

  it('locks a fresh rate when the amount or date changes', () => {
    const edited = editExpenseDraft(
      site,
      project,
      draft,
      { ...cementInLeones, incurredOn: '2026-03-01', amount: parseMoney('2280.00', 'SLE') },
      rates,
    );
    expect(edited.fx).toMatchObject({ source: 'organisation', rateDate: '2026-01-01' });
    expect(edited.baseAmount).toEqual(parseMoney('100.00', 'USD'));
  });
});
