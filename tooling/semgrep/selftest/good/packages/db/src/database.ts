// Known-good: database.ts owns the pool: the ping and withTx().
export async function ping(pool: Pool) {
  await pool.query("SELECT 1");
  const client = await pool.connect();
  client.release();
}
