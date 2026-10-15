// Known-good: other packages/db code goes through withTx().
import { sql } from "drizzle-orm";

export async function seed(db: Database, ctx: TxContext) {
  await db.withTx(ctx, (tx) =>
    tx.execute(sql`INSERT INTO bricx.projects (name) VALUES (${"a"})`),
  );
}
