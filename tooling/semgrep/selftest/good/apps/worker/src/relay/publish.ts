// Known-good: the outbox relay is the one place that publishes to BullMQ.
import { Queue } from "bullmq";

const queue = new Queue("notifications");
export async function publish(
  id: string,
  topic: string,
  payload: unknown,
): Promise<void> {
  await queue.add(topic, payload, { jobId: id });
}
