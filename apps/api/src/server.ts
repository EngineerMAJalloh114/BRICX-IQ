import pg from 'pg';

import { buildApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = await buildApp(config, pool);

await app.listen({ port: config.PORT, host: '0.0.0.0' });
