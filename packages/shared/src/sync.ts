import { z } from 'zod';

import { EXPENSE_STATUSES, RATE_SOURCES } from './expenses';
import { isCurrencyCode } from './money';
import { COST_CATEGORIES, PROJECT_STATUSES } from './projects';
import { writableTables } from './tables';

const currency = z.string().refine(isCurrencyCode, 'Unknown ISO 4217 currency code');
const isoDate = z.iso.date();
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const minor = z.number().int().safe();

/**
 * Fields a client may write on a project. Timestamps and created_by are set by
 * the server; organisation_id is only taken when the project is created.
 */
export const projectWriteSchema = z.object({
  organisation_id: z.uuid(),
  name: z.string().trim().min(1).max(200),
  code: optionalText(50),
  client_name: optionalText(200),
  location: optionalText(200),
  currency,
  status: z.enum(PROJECT_STATUSES),
  start_date: isoDate.nullable().optional(),
  end_date: isoDate.nullable().optional(),
});

export type ProjectWrite = z.infer<typeof projectWriteSchema>;

/** A budget line's organisation is copied from its project by the database. */
export const budgetLineWriteSchema = z.object({
  project_id: z.uuid(),
  category: z.enum(COST_CATEGORIES),
  description: z.string().trim().min(1).max(500),
  amount_minor: minor.nonnegative(),
  amount_currency: currency,
});

/**
 * Status changes arrive as ordinary writes to `status`; the database applies
 * the workflow and stamps who submitted or decided, and the API checks the
 * user's permission for the transition first.
 */
export const expenseWriteSchema = z.object({
  project_id: z.uuid(),
  budget_line_id: z.uuid().nullable().optional(),
  category: z.enum(COST_CATEGORIES),
  description: z.string().trim().min(1).max(500),
  vendor: optionalText(200),
  incurred_on: isoDate,
  amount_minor: minor.positive(),
  amount_currency: currency,
  fx_rate: z.string().regex(/^\d{1,12}(\.\d{1,12})?$/, 'Rate must be a positive decimal'),
  fx_rate_date: isoDate,
  fx_rate_source: z.enum(RATE_SOURCES),
  fx_manual_reason: optionalText(500),
  base_amount_minor: minor,
  base_amount_currency: currency,
  status: z.enum(EXPENSE_STATUSES).optional(),
  rejection_reason: optionalText(500),
});

/** Validation for each writable table, keyed by table name. */
export const tableWriteSchemas = {
  projects: projectWriteSchema,
  budget_lines: budgetLineWriteSchema,
  expenses: expenseWriteSchema,
} as const;

/**
 * One local change queued on a device, mirroring PowerSync's CRUD entry:
 * PUT creates or replaces a row, PATCH updates some columns, DELETE removes it.
 */
export const crudOperationSchema = z.object({
  op: z.enum(['PUT', 'PATCH', 'DELETE']),
  table: z.enum(writableTables),
  id: z.uuid(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export type CrudOperation = z.infer<typeof crudOperationSchema>;

/** A device transaction uploaded to the API; it is applied atomically. */
export const uploadBatchSchema = z.object({
  operations: z.array(crudOperationSchema).min(1).max(1000),
});

export type UploadBatch = z.infer<typeof uploadBatchSchema>;
