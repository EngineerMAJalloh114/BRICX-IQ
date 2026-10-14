// Money at the boundary (P3-04 D6, architect item 2): the same MoneySchema
// and MoneyJsonSchema objects as @bricx/money, re-exported, never
// redefined. Re-parse with MoneySchema at every boundary: isMoney is a
// per-module WeakSet (ADR 0045), so a Money that crossed structuredClone or
// a worker is not Money until it is parsed again. Issue messages are
// MoneyError codes; the envelope reports them as money.<code>.
export { MoneyJsonSchema, MoneySchema } from "@bricx/money/schema";
