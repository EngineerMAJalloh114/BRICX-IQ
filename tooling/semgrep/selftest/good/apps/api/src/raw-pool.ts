// Known-good: DB access goes through withTx() from @bricx/db.
import { withTx } from "@bricx/db/tx";

export const run = withTx;
