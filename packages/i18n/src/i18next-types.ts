// i18next's CustomTypeOptions (ROADMAP P3-03): typed keys for code that
// uses an i18next instance directly, such as react-i18next at P7. Import
// this module once ("@bricx/i18n/i18next-types") to turn it on. The typed
// ICU arguments come from createTranslator's `t`; i18next's own types only
// know `{{name}}` interpolation, not ICU placeholders.
import type { EN_RESOURCES } from "./catalog.ts";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    keySeparator: false;
    nsSeparator: ":";
    resources: typeof EN_RESOURCES;
  }
}

export {};
