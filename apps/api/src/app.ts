import cors from '@fastify/cors';
import { uploadBatchSchema } from '@bricx/shared';
import Fastify from 'fastify';
import type pg from 'pg';
import { z } from 'zod';

import { issueToken, requireAuth } from './auth';
import type { Config } from './config';
import { UploadRejected, applyOperations } from './upload';

export async function buildApp(config: Config, pool: pg.Pool) {
  const app = Fastify({ logger: config.NODE_ENV !== 'test' });
  await app.register(cors);

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });

  // Placeholder sign-in so the app can sync during development. Real
  // authentication replaces this before anything ships.
  if (config.NODE_ENV !== 'production') {
    app.post('/auth/dev-token', async (request, reply) => {
      const body = z.object({ email: z.email() }).safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'email is required' });
      // Find or create the user so changes are attributed to a real users row.
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO users (email, display_name) VALUES ($1, $1)
         ON CONFLICT (lower(email)) DO UPDATE SET email = users.email
         RETURNING id`,
        [body.data.email],
      );
      return {
        token: await issueToken(config.JWT_SECRET, rows[0]!.id),
        powersyncUrl: config.POWERSYNC_URL,
      };
    });
  }

  // Devices upload their queued local changes here; PowerSync then streams
  // the committed rows back down to every device.
  app.post(
    '/sync/upload',
    { preHandler: requireAuth(config.JWT_SECRET) },
    async (request, reply) => {
      const batch = uploadBatchSchema.safeParse(request.body);
      if (!batch.success) {
        return reply.code(422).send({ error: 'Invalid upload', details: batch.error.issues });
      }
      try {
        await applyOperations(pool, request.auth!.userId, batch.data.operations);
      } catch (error) {
        if (error instanceof UploadRejected) {
          return reply.code(422).send({ error: error.message, details: error.details });
        }
        throw error;
      }
      return { applied: batch.data.operations.length };
    },
  );

  return app;
}
