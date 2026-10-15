// Known-bad: raw SQL and Drizzle's raw-client escape hatches (P4-03).
import { sql } from "drizzle-orm";

export async function unsafe(tx: Tx, column: string) {
  await tx.execute(sql.raw(`SELECT ${column} FROM bricx.projects`));
  await tx.$client.query("SELECT 1");
  await tx.session.client.query("SELECT 1");
  const client = tx.$client;
  return client;
}
