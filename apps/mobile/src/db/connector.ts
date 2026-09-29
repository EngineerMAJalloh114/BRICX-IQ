import type { CrudOperation } from '@bricx/shared';
import type {
  AbstractPowerSyncDatabase,
  PowerSyncBackendConnector,
  PowerSyncCredentials,
} from '@powersync/common';

export interface Session {
  token: string;
  powersyncUrl: string;
}

export interface ConnectorOptions {
  apiUrl: string;
  getSession: () => Promise<Session | null>;
  fetch?: typeof fetch;
  onRejected?: (status: number, body: unknown) => void;
}

/**
 * Bridges PowerSync to the BRICX IQ API: it hands PowerSync the user's token
 * for downloading changes and uploads locally queued writes to the API, which
 * validates and audits them before they reach PostgreSQL.
 */
export class BricxConnector implements PowerSyncBackendConnector {
  constructor(private readonly options: ConnectorOptions) {}

  async fetchCredentials(): Promise<PowerSyncCredentials | null> {
    const session = await this.options.getSession();
    return session ? { endpoint: session.powersyncUrl, token: session.token } : null;
  }

  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    const transaction = await database.getNextCrudTransaction();
    if (!transaction) return;

    const session = await this.options.getSession();
    if (!session) throw new Error('Not signed in; keeping changes queued');

    const operations: CrudOperation[] = transaction.crud.map((entry) => ({
      op: entry.op,
      table: entry.table as CrudOperation['table'],
      id: entry.id,
      data: entry.opData,
    }));

    const doFetch = this.options.fetch ?? fetch;
    const response = await doFetch(`${this.options.apiUrl}/sync/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ operations }),
    });

    if (response.ok) {
      await transaction.complete();
      return;
    }
    // The server refused this data outright, so retrying can never succeed and
    // would block every later change. Report it and move on; PowerSync will
    // replace the local rows with the server's copy.
    if (response.status === 422) {
      this.options.onRejected?.(response.status, await response.json().catch(() => null));
      await transaction.complete();
      return;
    }
    // Offline, server errors and expired tokens: throw so PowerSync retries.
    throw new Error(`Upload failed with status ${response.status}`);
  }
}
