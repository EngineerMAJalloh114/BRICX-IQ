// Known-bad: BullMQ outside apps/worker (P4-06, ADR 0056). The API writes
// outbox rows; only the worker's relay talks to BullMQ.
import { Queue } from "bullmq";
import type { JobsOptions } from "bullmq";

export const queue = (name: string, options: JobsOptions) =>
  new Queue(name, { defaultJobOptions: options, connection: {} });
export const lazy = () => import("bullmq");
