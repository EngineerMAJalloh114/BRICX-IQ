// The access-grants module's public API (CLAUDE.md rule 13): other
// modules import from here only.
export { AccessGrantsModule } from "./access-grants.module.js";
export {
  ACCESS_GRANTS_EXPIRE,
  type AccessGrantsExpire,
} from "./access-grants.events.js";
