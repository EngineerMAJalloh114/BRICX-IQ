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

/** The signed-in user's id: the subject of their token. */
export function userIdFromToken(token: string): string | null {
  try {
    const payload = token.split('.')[1] ?? '';
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const sub: unknown = JSON.parse(json).sub;
    return typeof sub === 'string' ? sub : null;
  } catch {
    return null;
  }
}

export async function currentUserId(): Promise<string | null> {
  const current = await getSession();
  return current ? userIdFromToken(current.token) : null;
}
