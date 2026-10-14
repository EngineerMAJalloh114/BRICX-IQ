// Type tests (D6), checked by `tsc --noEmit` (pnpm typecheck): typed keys
// and ICU arguments from the generated en key map. Each @ts-expect-error
// must be needed; types-sabotage.test.ts proves they fail when the types
// are loosened.
import i18next from "i18next";
import type { MessageKey } from "../src/generated/keys.ts";
import "../src/i18next-types.ts";
import { createTranslator } from "../src/translate.ts";
import type { MessageArgs } from "../src/translate.ts";

const { t } = createTranslator("en");

export const allowed = [
  t("common:save"),
  t("common:welcome_user", { name: "Aminata" }),
  t("common:welcome_user", { name: 7 }),
  t("field:defects_open", { defects: 2 }),
  t("construction:site_status", { status: "active" }),
  t("validation:out_of_range", { min: 1, max: 9 }),
];

// @ts-expect-error marker:unknown-key
t("common:does_not_exist");
// @ts-expect-error marker:no-namespace
t("save");
// @ts-expect-error marker:missing-args-object
t("common:welcome_user");
// @ts-expect-error marker:missing-argument
t("common:welcome_user", {});
// @ts-expect-error marker:missing-second-argument
t("validation:out_of_range", { min: 1 });
// @ts-expect-error marker:plural-not-number
t("field:defects_open", { defects: "2" });
// @ts-expect-error marker:select-not-string
t("construction:site_status", { status: 1 });
// @ts-expect-error marker:no-args-expected
t("common:save", { name: "A" });
// @ts-expect-error marker:extra-argument
t("common:welcome_user", { name: "A", extra: 1 });

// i18next's own t through CustomTypeOptions (ROADMAP P3-03).
export const viaI18next = i18next.t("common:save");
// @ts-expect-error marker:i18next-unknown-key
i18next.t("common:does_not_exist");

export const key: MessageKey = "finance:retention";
// @ts-expect-error marker:closed-union
export const notAKey: MessageKey = "finance:nope";
export const args: MessageArgs<"field:defects_open"> = { defects: 1 };
