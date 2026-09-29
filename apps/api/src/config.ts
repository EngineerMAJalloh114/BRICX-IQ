import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().default('postgres://bricx:bricx@localhost:5432/bricx'),
  JWT_SECRET: z.string().min(32).default('dev-only-secret-change-me-at-least-32-chars'),
  POWERSYNC_URL: z.url().default('http://localhost:8080'),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = envSchema.parse(env);
  if (config.NODE_ENV === 'production' && env.JWT_SECRET === undefined) {
    throw new Error('JWT_SECRET must be set in production');
  }
  return config;
}
