// The outbox module's public API (CLAUDE.md rule 13): other modules import
// from here only.
export { OutboxModule } from "./outbox.module.js";
export { OutboxService } from "./outbox.service.js";
export { OutboxError, type OutboxErrorCode } from "@bricx/db/outbox";
