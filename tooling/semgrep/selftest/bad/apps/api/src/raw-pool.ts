// Known-bad: the raw pool outside packages/db (CLAUDE.md rule 4).
import { Pool } from "pg";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/node-postgres";

export const pool = new Pool();
export const sql = postgres();
export const db = drizzle(pool);
const pg = require("pg");
export const client = new pg.Client();
