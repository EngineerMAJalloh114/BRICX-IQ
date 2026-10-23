// The SoD module's public API (CLAUDE.md rule 13): what other modules may
// import from it.
export { SodModule } from "./sod.module.js";
export {
  type ApprovalState,
  MAX_APPROVER_CANDIDATES,
  type SodAction,
  type SodRecord,
  SodService,
} from "./sod.service.js";
