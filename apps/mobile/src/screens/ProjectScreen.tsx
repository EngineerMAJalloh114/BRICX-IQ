import {
  COST_CATEGORIES,
  ValidationError,
  can,
  checkExpenseAction,
  createExpenseDraft,
  formatMoney,
  parseMoney,
  summarizeBudget,
  transitionExpense,
  validateBudgetLine,
  type CostCategory,
  type Expense,
  type ExpenseAction,
  type Money,
  type Project,
  type SpendFigures,
} from '@bricx/shared';
import { usePowerSync } from '@powersync/react';
import { useState } from 'react';
import { Button, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { errorMessage, newId, today, useProjectData, useRateBook, type Me } from '../data';
import { locale, t } from '../i18n';
import { styles } from './styles';

const fmt = (m: Money) => formatMoney(m, locale);

function Figures({ figures }: { figures: SpendFigures }) {
  return (
    <View>
      <Text>
        {t('budget.budgeted')}: {fmt(figures.budget)}
      </Text>
      <Text>
        {t('budget.approved')}: {fmt(figures.approved)}
        {figures.usedBasisPoints !== null
          ? ` · ${t('budget.used', { percent: Math.floor(figures.usedBasisPoints / 100) })}`
          : ''}
      </Text>
      <Text>
        {t('budget.pending')}: {fmt(figures.pending)}
      </Text>
      <Text>
        {t('budget.remaining')}: {fmt(figures.remaining)}
      </Text>
      {figures.overBudget ? <Text style={styles.warning}>{t('budget.overBudget')}</Text> : null}
    </View>
  );
}

function Chips<T extends string>(props: {
  options: readonly T[];
  value: T | null;
  label: (value: T) => string;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.row}>
      {props.options.map((option) => {
        const selected = option === props.value;
        return (
          <Pressable
            key={option}
            style={[styles.chip, selected && styles.chipSelected]}
            onPress={() => props.onChange(option)}
          >
            <Text style={selected ? styles.chipTextSelected : styles.chipText}>
              {props.label(option)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function BudgetLineForm({ project, me }: { project: Project; me: Me }) {
  const db = usePowerSync();
  const [category, setCategory] = useState<CostCategory>('materials');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function add() {
    try {
      let money: Money;
      try {
        money = parseMoney(amount || '0', project.currency);
      } catch {
        throw new ValidationError([{ field: 'amount', key: 'invalid' }]);
      }
      const errors = validateBudgetLine(project, { category, description, amount: money });
      if (errors.length) throw new ValidationError(errors);
      const now = new Date().toISOString();
      await db.execute(
        `INSERT INTO budget_lines (id, organisation_id, project_id, category, description, amount_minor, amount_currency, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId(),
          project.organisationId,
          project.id,
          category,
          description.trim(),
          Number(money.amountMinor),
          money.currency,
          me.userId,
          now,
          now,
        ],
      );
      setDescription('');
      setAmount('');
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <View style={styles.form}>
      <Chips
        options={COST_CATEGORIES}
        value={category}
        label={(c) => t(`budget.category.${c}`)}
        onChange={setCategory}
      />
      <View style={styles.row}>
        <TextInput
          style={[styles.input, styles.flex]}
          placeholder={t('budget.description')}
          value={description}
          onChangeText={setDescription}
        />
        <TextInput
          style={[styles.input, styles.flex]}
          placeholder={`${t('money.amount')} (${project.currency})`}
          keyboardType="decimal-pad"
          value={amount}
          onChangeText={setAmount}
        />
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button title={t('budget.addLine')} onPress={add} />
    </View>
  );
}

function ExpenseForm({ project, me }: { project: Project; me: Me }) {
  const db = usePowerSync();
  const rates = useRateBook();
  const { lines } = useProjectData(project.id);
  const [category, setCategory] = useState<CostCategory>('materials');
  const [lineId, setLineId] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [vendor, setVendor] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('');
  const [date, setDate] = useState(today());
  const [manualRate, setManualRate] = useState('');
  const [manualReason, setManualReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function add() {
    try {
      const code = (currency.trim() || project.currency).toUpperCase();
      let money: Money;
      try {
        money = parseMoney(amount || '0', code);
      } catch {
        throw new ValidationError([{ field: 'amount', key: 'invalid' }]);
      }
      // The rate in force on the day paid is looked up in the rates synced to
      // this device and locked onto the expense, so it works offline.
      const expense = createExpenseDraft(
        me,
        project,
        {
          projectId: project.id,
          budgetLineId: lineId,
          category,
          description,
          vendor: vendor.trim() || null,
          incurredOn: date.trim(),
          amount: money,
          manualRate: manualRate.trim()
            ? { rate: manualRate.trim(), reason: manualReason }
            : undefined,
        },
        rates,
        newId(),
      );
      const now = new Date().toISOString();
      await db.execute(
        `INSERT INTO expenses (id, organisation_id, project_id, budget_line_id, category, description, vendor,
           incurred_on, amount_minor, amount_currency, fx_rate, fx_rate_date, fx_rate_source, fx_manual_reason,
           base_amount_minor, base_amount_currency, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
        [
          expense.id,
          expense.organisationId,
          expense.projectId,
          expense.budgetLineId ?? null,
          expense.category,
          expense.description,
          expense.vendor ?? null,
          expense.incurredOn,
          Number(expense.amount.amountMinor),
          expense.amount.currency,
          expense.fx.rate,
          expense.fx.rateDate,
          expense.fx.source,
          expense.fx.manualReason ?? null,
          Number(expense.baseAmount.amountMinor),
          expense.baseAmount.currency,
          me.userId,
          now,
          now,
        ],
      );
      setDescription('');
      setVendor('');
      setAmount('');
      setManualRate('');
      setManualReason('');
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const live = lines.filter((l) => !l.deletedAt);
  return (
    <View style={styles.form}>
      <Chips
        options={COST_CATEGORIES}
        value={category}
        label={(c) => t(`budget.category.${c}`)}
        onChange={setCategory}
      />
      <Chips
        options={['', ...live.map((l) => l.id)]}
        value={lineId ?? ''}
        label={(id) => live.find((l) => l.id === id)?.description ?? t('expenses.noLine')}
        onChange={(id) => setLineId(id || null)}
      />
      <TextInput
        style={styles.input}
        placeholder={t('expenses.description')}
        value={description}
        onChangeText={setDescription}
      />
      <TextInput
        style={styles.input}
        placeholder={t('expenses.vendor')}
        value={vendor}
        onChangeText={setVendor}
      />
      <View style={styles.row}>
        <TextInput
          style={[styles.input, styles.flex]}
          placeholder={t('money.amount')}
          keyboardType="decimal-pad"
          value={amount}
          onChangeText={setAmount}
        />
        <TextInput
          style={[styles.input, styles.currency]}
          placeholder={project.currency}
          autoCapitalize="characters"
          maxLength={3}
          value={currency}
          onChangeText={setCurrency}
        />
        <TextInput
          style={[styles.input, styles.flex]}
          placeholder={t('expenses.incurredOn')}
          value={date}
          onChangeText={setDate}
        />
      </View>
      <View style={styles.row}>
        <TextInput
          style={[styles.input, styles.flex]}
          placeholder={t('expenses.manualRate')}
          keyboardType="decimal-pad"
          value={manualRate}
          onChangeText={setManualRate}
        />
        {manualRate.trim() ? (
          <TextInput
            style={[styles.input, styles.flex]}
            placeholder={t('expenses.manualRateReason')}
            value={manualReason}
            onChangeText={setManualReason}
          />
        ) : null}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button title={t('expenses.new')} onPress={add} />
    </View>
  );
}

const ACTIONS = ['submit', 'withdraw', 'approve', 'reject', 'reopen'] as const;

function ExpenseItem({ expense, me }: { expense: Expense; me: Me }) {
  const db = usePowerSync();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const allowed = ACTIONS.filter((a) => checkExpenseAction(me, expense, a) === null);

  async function run(action: Exclude<ExpenseAction, 'edit' | 'delete'>) {
    try {
      const next = transitionExpense(me, expense, action, reason);
      // Only status and the rejection reason are sent; the server stamps who
      // submitted or decided, and checks the same rules again.
      await db.execute(
        `UPDATE expenses SET status = ?, rejection_reason = ?, submitted_by = ?, decided_by = ?, updated_at = ?
         WHERE id = ?`,
        [
          next.status,
          next.rejectionReason ?? null,
          next.submittedBy ?? null,
          next.decidedBy ?? null,
          new Date().toISOString(),
          expense.id,
        ],
      );
      setReason('');
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function remove() {
    try {
      if (checkExpenseAction(me, expense, 'delete')) return;
      await db.execute('DELETE FROM expenses WHERE id = ?', [expense.id]);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const converted = expense.amount.currency !== expense.baseAmount.currency;
  return (
    <View style={styles.item}>
      <Text>
        {expense.incurredOn} · {expense.description}
        {expense.vendor ? ` · ${expense.vendor}` : ''}
      </Text>
      <Text>
        {fmt(expense.amount)}
        {converted ? ` → ${fmt(expense.baseAmount)}` : ''} ·{' '}
        {t(`expenses.status.${expense.status}`)}
      </Text>
      {converted ? (
        <Text style={styles.muted}>
          {t('expenses.rate', {
            from: expense.amount.currency,
            to: expense.baseAmount.currency,
            rate: expense.fx.rate,
            date: expense.fx.rateDate,
          })}
        </Text>
      ) : null}
      {expense.rejectionReason ? <Text style={styles.error}>{expense.rejectionReason}</Text> : null}
      {allowed.includes('reject') ? (
        <TextInput
          style={styles.input}
          placeholder={t('expenses.rejectionReason')}
          value={reason}
          onChangeText={setReason}
        />
      ) : null}
      <View style={styles.row}>
        {allowed.map((action) => (
          <Button key={action} title={t(`expenses.action.${action}`)} onPress={() => run(action)} />
        ))}
        {checkExpenseAction(me, expense, 'delete') === null ? (
          <Button title={t('common.delete')} onPress={remove} />
        ) : null}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

export function ProjectScreen({
  projectId,
  me,
  onBack,
}: {
  projectId: string;
  me: Me;
  onBack: () => void;
}) {
  const { project, lines, expenses } = useProjectData(projectId);
  if (!project) {
    return (
      <View style={styles.screen}>
        <Button title={t('common.back')} onPress={onBack} />
      </View>
    );
  }
  const summary = summarizeBudget(project, lines, expenses);
  const lineName = (id: string | null | undefined) =>
    lines.find((l) => l.id === id)?.description ?? t('budget.unallocated');

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: 64 }}>
      <Button title={t('common.back')} onPress={onBack} />
      <Text style={styles.title}>
        {project.code ? `${project.code} · ` : ''}
        {project.name}
      </Text>
      <Text style={styles.muted}>
        {project.currency} · {t(`projects.status.${project.status}`)}
      </Text>
      <Figures figures={summary.total} />

      <Text style={styles.heading}>{t('budget.title')}</Text>
      {summary.lines.length === 0 ? <Text style={styles.muted}>{t('budget.none')}</Text> : null}
      {summary.lines.map((line) => (
        <View key={line.lineId} style={styles.item}>
          <Text>
            {t(`budget.category.${line.category}`)} · {line.description}
          </Text>
          <Figures figures={line} />
        </View>
      ))}
      {can(me.role, 'budget.edit') ? <BudgetLineForm project={project} me={me} /> : null}

      <Text style={styles.heading}>{t('expenses.title')}</Text>
      {expenses.length === 0 ? <Text style={styles.muted}>{t('expenses.none')}</Text> : null}
      {expenses.map((expense) => (
        <View key={expense.id}>
          <Text style={styles.muted}>{lineName(expense.budgetLineId)}</Text>
          <ExpenseItem expense={expense} me={me} />
        </View>
      ))}
      {can(me.role, 'expenses.create') ? <ExpenseForm project={project} me={me} /> : null}
    </ScrollView>
  );
}
