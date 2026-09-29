import { PowerSyncDatabase } from '@powersync/react-native';

import { AppSchema } from './schema';

// iOS and Android: SQLite on the device via op-sqlite.
export const db = new PowerSyncDatabase({
  schema: AppSchema,
  database: { dbFilename: 'bricx.db' },
});
