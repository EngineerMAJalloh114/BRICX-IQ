// @bricx/db/schema: the bricx schema object, the shared column helpers and
// every table.
export { bricx } from "./namespace.js";
export {
  createdAt,
  createdBy,
  deletedAt,
  id,
  orgId,
  updatedAt,
  version,
} from "./columns.js";
export * from "./tables.js";
