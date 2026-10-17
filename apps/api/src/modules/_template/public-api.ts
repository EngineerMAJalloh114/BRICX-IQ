// The TemplateItems module's public API (CLAUDE.md rule 13): other modules
// import from here only.
export { TemplateItemsModule } from "./template-items.module.js";
export { TemplateItemsService } from "./template-items.service.js";
export {
  TEMPLATE_ITEMS_CREATED,
  type TemplateItemCreated,
} from "./template-items.events.js";
