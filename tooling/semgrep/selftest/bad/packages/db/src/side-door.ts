// Known-bad: a query on the pool or a client outside database.ts and
// migrate.ts, so outside withTx() (P4-03).
export async function sideDoor(pool: Pool, client: Client) {
  await pool.query("SELECT 1");
  const borrowed = await pool.connect();
  await client.query("SELECT 1");
  borrowed.release();
}
