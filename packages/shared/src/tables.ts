/**
 * Tables that sync between the server (PostgreSQL) and devices (SQLite).
 * The mobile app builds its local schema from these definitions and the API
 * only accepts writes to the columns listed here.
 */
export type ColumnType = 'text' | 'integer' | 'real';

export const syncedTables = {
  projects: {
    name: 'text',
    code: 'text',
    currency: 'text',
    budget_minor: 'integer',
    status: 'text',
    created_at: 'text',
    updated_at: 'text',
  },
} as const satisfies Record<string, Record<string, ColumnType>>;

export type SyncedTable = keyof typeof syncedTables;

export const projectStatuses = ['planning', 'active', 'on_hold', 'completed'] as const;
export type ProjectStatus = (typeof projectStatuses)[number];
