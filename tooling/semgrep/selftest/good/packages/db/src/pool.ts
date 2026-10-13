// Known-good: packages/db owns the pool.
import { Pool } from "pg";

export const pool = new Pool();
