// The segregation-of-duties pairs as data (ROADMAP P3-05 step 4; architect
// ruling 5; ADR 0048). Kept apart from sod.ts so the generators (which run
// under plain Node in scripts/gen.mjs) import no @bricx/ids code.
import type { PermissionName } from "./catalogue.ts";

export interface SodRule {
  /** `${first}|${second}` */
  readonly id: string;
  readonly first: PermissionName;
  readonly second: PermissionName;
  /** "roadmap": named in ROADMAP P3-05; "owner_review": added in the plan, listed for review in ADR 0048. */
  readonly source: "roadmap" | "owner_review";
}

const rule = (
  first: PermissionName,
  second: PermissionName,
  source: SodRule["source"],
): SodRule =>
  Object.freeze({ id: `${first}|${second}`, first, second, source });

export const SOD_RULES: readonly SodRule[] = Object.freeze([
  rule("finance.payment.request", "finance.payment.approve", "roadmap"),
  rule(
    "supply.purchase_order.create",
    "supply.goods_receipt.create",
    "roadmap",
  ),
  rule("finance.payment.record", "finance.reconciliation.create", "roadmap"),
  rule("field.dailylog.create", "field.dailylog.approve", "owner_review"),
  rule("field.attendance.create", "field.attendance.approve", "owner_review"),
  rule(
    "supply.material_request.create",
    "supply.material_request.approve",
    "owner_review",
  ),
  rule(
    "supply.purchase_order.create",
    "supply.purchase_order.approve",
    "owner_review",
  ),
  rule("finance.budget.create", "finance.budget.approve", "owner_review"),
  rule(
    "finance.expenditure.create",
    "finance.expenditure.approve",
    "owner_review",
  ),
  rule(
    "finance.change_order.create",
    "finance.change_order.approve",
    "owner_review",
  ),
]);
