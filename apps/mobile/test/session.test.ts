import { describe, expect, it } from 'vitest';

import { userIdFromToken } from '../src/session';

const encode = (value: object) =>
  btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

describe('userIdFromToken', () => {
  it('reads the user id from the token subject', () => {
    const id = '0b9f5a3e-6f1c-4c1e-9d59-6c1b8f3d2a10';
    expect(userIdFromToken(`${encode({ alg: 'HS256' })}.${encode({ sub: id })}.sig`)).toBe(id);
  });

  it('returns null for a malformed token', () => {
    expect(userIdFromToken('not-a-token')).toBeNull();
  });
});
