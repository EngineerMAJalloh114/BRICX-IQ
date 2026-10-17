// TemplateItems' outbox event (P4-09, ADR 0059; CLAUDE.md rule 5): written
// by OutboxService.enqueue() in the creating transaction, published by
// the worker's relay after COMMIT. The topic is registered in
// @bricx/db/outbox; the payload carries ids, never names or personal data.
import type { TemplateItemData } from "./template-items.dto.js";

export const TEMPLATE_ITEMS_CREATED = "template_items.created";

export interface TemplateItemCreated {
  readonly id: string;
  readonly projectId: string;
}

export const createdPayload = (
  item: TemplateItemData,
): TemplateItemCreated => ({
  id: item.id,
  projectId: item.projectId,
});
