import { PowerSyncDatabase } from '@powersync/web';

import { AppSchema } from './schema';

// Browsers: SQLite compiled to WebAssembly, persisted in IndexedDB. Metro
// cannot bundle web workers, so the prebuilt PowerSync worker is copied into
// public/ on install and loaded from there.
export const db = new PowerSyncDatabase({
  schema: AppSchema,
  database: {
    dbFilename: 'bricx.db',
    enableMultiTabs: false,
    worker: '/@powersync/worker.js',
  },
});
