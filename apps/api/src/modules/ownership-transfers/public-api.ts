// The ownership-transfers module's public API (CLAUDE.md rule 13): the app
// imports from here only. The cascades other modules run are
// @bricx/db/ownership's (common/db/ownership-canceller.ts).
export { OwnershipTransfersModule } from "./ownership-transfers.module.js";
export {
  OWNERSHIP_EXPIRE,
  type OwnershipExpire,
} from "./ownership-transfers.events.js";
export { TRANSFER_TTL_MS, foldName } from "./ownership-transfers.service.js";
