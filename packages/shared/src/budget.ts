/**
 * Budget against actual spend for a project, in its base currency.
 * Matches the project_budget_summary view in the database, broken down by line.
 */
import type { Expense } from './expenses';
import { add, money, subtract, type Money } from './money';
import type { BudgetLine, CostCategory, Project } from './projects';

export interface SpendFigures {
  readonly budget: Money;
  /** Approved expenses. */
  readonly approved: Money;
  /** Submitted and waiting for a decision. */
  readonly pending: Money;
  /** budget - approved. Negative when over budget. */
  readonly remaining: Money;
  /** approved / budget in basis points (10000 = 100%), or null with no budget. */
  readonly usedBasisPoints: number | null;
  /** approved + pending already exceed the budget. */
  readonly overBudget: boolean;
}

export interface BudgetLineSummary extends SpendFigures {
  readonly lineId: string;
  readonly category: CostCategory;
  readonly description: string;
}

export interface BudgetSummary {
  readonly currency: string;
  readonly total: SpendFigures;
  readonly lines: readonly BudgetLineSummary[];
  /** Spending not booked to any budget line. */
  readonly unallocated: { readonly approved: Money; readonly pending: Money };
}

function figures(budget: Money, approved: Money, pending: Money): SpendFigures {
  return {
    budget,
    approved,
    pending,
    remaining: subtract(budget, approved),
    usedBasisPoints:
      budget.amountMinor === 0n
        ? null
        : Number((approved.amountMinor * 10000n) / budget.amountMinor),
    overBudget: add(approved, pending).amountMinor > budget.amountMinor,
  };
}

export function summarizeBudget(
  project: Project,
  lines: readonly BudgetLine[],
  expenses: readonly Expense[],
): BudgetSummary {
  const zero = money(0n, project.currency);
  const live = <T extends { deletedAt?: string | null; projectId: string }>(rows: readonly T[]) =>
    rows.filter((r) => !r.deletedAt && r.projectId === project.id);

  const byLine = new Map<string | null, { approved: Money; pending: Money }>();
  for (const e of live(expenses)) {
    if (e.status !== 'approved' && e.status !== 'submitted') continue;
    const key = e.budgetLineId ?? null;
    const acc = byLine.get(key) ?? { approved: zero, pending: zero };
    // add() throws on a currency mismatch, so a bad base amount cannot slip in.
    if (e.status === 'approved') acc.approved = add(acc.approved, e.baseAmount);
    else acc.pending = add(acc.pending, e.baseAmount);
    byLine.set(key, acc);
  }

  const lineSummaries = live(lines).map((line) => {
    const spend = byLine.get(line.id) ?? { approved: zero, pending: zero };
    byLine.delete(line.id);
    return {
      lineId: line.id,
      category: line.category,
      description: line.description,
      ...figures(line.amount, spend.approved, spend.pending),
    };
  });

  // Whatever is left was booked to no line (or to a line that is gone).
  let unallocated = { approved: zero, pending: zero };
  for (const spend of byLine.values()) {
    unallocated = {
      approved: add(unallocated.approved, spend.approved),
      pending: add(unallocated.pending, spend.pending),
    };
  }

  const sumOf = (pick: (s: SpendFigures) => Money, extra: Money) =>
    lineSummaries.reduce((acc, s) => add(acc, pick(s)), extra);

  return {
    currency: project.currency,
    total: figures(
      sumOf((s) => s.budget, zero),
      sumOf((s) => s.approved, unallocated.approved),
      sumOf((s) => s.pending, unallocated.pending),
    ),
    lines: lineSummaries,
    unallocated,
  };
}
