// Known-bad: a job enqueued directly, not through the outbox (CLAUDE.md rule 5).
import { Queue } from "bullmq";

const queue = new Queue("notifications");
export async function notify(userId: string): Promise<void> {
  await queue.add("email", { userId });
  await new Queue("audit").addBulk([{ name: "x", data: {} }]);
}
