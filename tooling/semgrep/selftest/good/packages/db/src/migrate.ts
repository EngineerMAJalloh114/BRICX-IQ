// Known-good: the migrator runs as bricx_owner on its own client.
export async function apply(client: Client) {
  await client.connect();
  await client.query("SELECT 1");
}
