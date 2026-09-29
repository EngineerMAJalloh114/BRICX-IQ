/**
 * Tables that sync between the server (PostgreSQL) and devices (SQLite).
 * The mobile app builds its local schema from these definitions. Devices may
 * only write to the tables in `writableTables`, and only the columns in each
 * table's write schema (sync.ts); everything else is set by the server.
 */
export type ColumnType = 'text' | 'integer' | 'real';

export const syncedTables = {
  projects: {
    organisation_id: 'text',
    name: 'text',
    code: 'text',
    client_name: 'text',
    location: 'text',
    currency: 'text',
    status: 'text',
    start_date: 'text',
    end_date: 'text',
    created_by: 'text',
    created_at: 'text',
    updated_at: 'text',
  },
  budget_lines: {
    organisation_id: 'text',
    project_id: 'text',
    category: 'text',
    description: 'text',
    amount_minor: 'integer',
    amount_currency: 'text',
    created_by: 'text',
    created_at: 'text',
    updated_at: 'text',
  },
  expenses: {
    organisation_id: 'text',
    project_id: 'text',
    budget_line_id: 'text',
    category: 'text',
    description: 'text',
    vendor: 'text',
    incurred_on: 'text',
    amount_minor: 'integer',
    amount_currency: 'text',
    // A decimal string; never a float.
    fx_rate: 'text',
    fx_rate_date: 'text',
    fx_rate_source: 'text',
    fx_manual_reason: 'text',
    base_amount_minor: 'integer',
    base_amount_currency: 'text',
    status: 'text',
    submitted_at: 'text',
    submitted_by: 'text',
    decided_at: 'text',
    decided_by: 'text',
    rejection_reason: 'text',
    created_by: 'text',
    created_at: 'text',
    updated_at: 'text',
  },
  // Read-only on devices.
  organisations: {
    name: 'text',
    base_currency: 'text',
  },
  memberships: {
    organisation_id: 'text',
    user_id: 'text',
    role: 'text',
  },
  exchange_rates: {
    organisation_id: 'text',
    base_currency: 'text',
    quote_currency: 'text',
    rate: 'text',
    effective_date: 'text',
  },
} as const satisfies Record<string, Record<string, ColumnType>>;

export type SyncedTable = keyof typeof syncedTables;

/** Tables devices may change; the others only sync down. */
export const writableTables = ['projects', 'budget_lines', 'expenses'] as const;
export type WritableTable = (typeof writableTables)[number];
