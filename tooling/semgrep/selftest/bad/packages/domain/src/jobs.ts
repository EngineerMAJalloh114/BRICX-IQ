// Known-bad: a shared package reaching for BullMQ (P4-06, ADR 0056).
const bull = require("bullmq");
export * from "bullmq";
export default bull;
