import type { Session } from './db/connector';
import { API_URL } from './config';

let session: Session | null = null;

/**
 * Development sign-in against the API's placeholder token endpoint. Real
 * authentication (and storing the token securely) replaces this.
 */
export async function getSession(): Promise<Session | null> {
  if (session) return session;
  try {
    const response = await fetch(`${API_URL}/auth/dev-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'dev@bricx.local' }),
    });
    if (!response.ok) return null;
    session = (await response.json()) as Session;
    return session;
  } catch {
    // Offline: the app keeps working locally and syncs once reachable.
    return null;
  }
}
