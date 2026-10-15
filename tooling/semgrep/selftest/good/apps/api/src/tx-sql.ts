// Known-good: parameterised SQL on the transaction withTx() hands over.
import { sql } from "drizzle-orm";

export async function safe(tx: Tx, orgId: string) {
  return tx.execute(
    sql`SELECT note FROM bricx.projects WHERE org_id = ${orgId}`,
  );
}

export const raw = { note: "sql.raw is named here only in a string" };
