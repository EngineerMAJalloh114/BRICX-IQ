import type { AbstractPowerSyncDatabase } from '@powersync/common';
import { describe, expect, it, vi } from 'vitest';

import { BricxConnector } from '../src/db/connector';

const session = { token: 'tok', powersyncUrl: 'http://sync' };

function fakeDatabase(crud: unknown[] | null) {
  const complete = vi.fn();
  const database = {
    getNextCrudTransaction: async () => (crud ? { crud, complete } : null),
  } as unknown as AbstractPowerSyncDatabase;
  return { database, complete };
}

const entry = { op: 'PUT', table: 'projects', id: 'p1', opData: { name: 'Site A' } };

describe('BricxConnector', () => {
  it('returns PowerSync credentials from the session', async () => {
    const connector = new BricxConnector({ apiUrl: 'http://api', getSession: async () => session });
    expect(await connector.fetchCredentials()).toEqual({ endpoint: 'http://sync', token: 'tok' });
  });

  it('uploads queued changes and completes the transaction', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const connector = new BricxConnector({
      apiUrl: 'http://api',
      getSession: async () => session,
      fetch,
    });
    const { database, complete } = fakeDatabase([entry]);

    await connector.uploadData(database);

    expect(fetch).toHaveBeenCalledWith(
      'http://api/sync/upload',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(
      (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body).toEqual({
      operations: [{ op: 'PUT', table: 'projects', id: 'p1', data: { name: 'Site A' } }],
    });
    expect(complete).toHaveBeenCalled();
  });

  it('keeps changes queued when the server is unreachable or failing', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 503 }));
    const connector = new BricxConnector({
      apiUrl: 'http://api',
      getSession: async () => session,
      fetch,
    });
    const { database, complete } = fakeDatabase([entry]);

    await expect(connector.uploadData(database)).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();
  });

  it('drops changes the server permanently rejects so the queue is not blocked', async () => {
    const fetch = vi.fn(async () => new Response('{"error":"bad"}', { status: 422 }));
    const onRejected = vi.fn();
    const connector = new BricxConnector({
      apiUrl: 'http://api',
      getSession: async () => session,
      fetch,
      onRejected,
    });
    const { database, complete } = fakeDatabase([entry]);

    await connector.uploadData(database);
    expect(onRejected).toHaveBeenCalledWith(422, { error: 'bad' });
    expect(complete).toHaveBeenCalled();
  });
});
