import type { FastifyReply, FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';

/** Tokens are verified by both this API and the PowerSync service. */
export const TOKEN_AUDIENCE = 'bricx';
export const TOKEN_KEY_ID = 'bricx-dev';

export interface AuthContext {
  userId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function issueToken(secret: string, userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', kid: TOKEN_KEY_ID })
    .setSubject(userId)
    .setAudience(TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key(secret));
}

export function requireAuth(secret: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) return reply.code(401).send({ error: 'Missing bearer token' });
    try {
      const { payload } = await jwtVerify(token, key(secret), {
        audience: TOKEN_AUDIENCE,
        algorithms: ['HS256'],
      });
      if (!payload.sub) throw new Error('Token has no subject');
      request.auth = { userId: payload.sub };
    } catch {
      return reply.code(401).send({ error: 'Invalid token' });
    }
  };
}
