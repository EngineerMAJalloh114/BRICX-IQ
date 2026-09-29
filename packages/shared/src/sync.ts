import { z } from 'zod';

import { isCurrencyCode } from './money';
import { projectStatuses } from './tables';

/** Fields a client may write on a project. Timestamps are set by the server. */
export const projectWriteSchema = z.object({
  name: z.string().trim().min(1).max(200),
  code: z.string().trim().max(50).nullable().optional(),
  currency: z.string().refine(isCurrencyCode, 'Unknown ISO 4217 currency code'),
  budget_minor: z.number().int().safe().nonnegative(),
  status: z.enum(projectStatuses),
});

export type ProjectWrite = z.infer<typeof projectWriteSchema>;

/** Validation for each synced table's writes, keyed by table name. */
export const tableWriteSchemas = {
  projects: projectWriteSchema,
} as const;

/**
 * One local change queued on a device, mirroring PowerSync's CRUD entry:
 * PUT creates or replaces a row, PATCH updates some columns, DELETE removes it.
 */
export const crudOperationSchema = z.object({
  op: z.enum(['PUT', 'PATCH', 'DELETE']),
  table: z.enum(['projects']),
  id: z.uuid(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export type CrudOperation = z.infer<typeof crudOperationSchema>;

/** A device transaction uploaded to the API; it is applied atomically. */
export const uploadBatchSchema = z.object({
  operations: z.array(crudOperationSchema).min(1).max(1000),
});

export type UploadBatch = z.infer<typeof uploadBatchSchema>;
