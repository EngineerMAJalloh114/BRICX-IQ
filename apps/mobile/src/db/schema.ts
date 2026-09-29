import { syncedTables } from '@bricx/shared';
import { Schema, Table, column } from '@powersync/common';

// The local SQLite schema is generated from the shared table definitions so
// devices and the API never disagree about which columns exist.
const tables = Object.fromEntries(
  Object.entries(syncedTables).map(([name, columns]) => [
    name,
    new Table(
      Object.fromEntries(Object.entries(columns).map(([key, type]) => [key, column[type]])),
    ),
  ]),
);

export const AppSchema = new Schema(tables);
