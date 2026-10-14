// The bundled catalogs (P3-03): one JSON file per locale and namespace,
// en the source of truth. Bundlers (Metro, Vite, the API build) inline the
// JSON; i18n:check proves fr and ar match en (keys, placeholders, plural
// arms). fr and ar text is machine-drafted and needs a native-speaker
// review before production or before they go into Tolgee (ADR 0046).
import enCommon from "../locales/en/common.json";
import enConstruction from "../locales/en/construction.json";
import enFinance from "../locales/en/finance.json";
import enField from "../locales/en/field.json";
import enErrors from "../locales/en/errors.json";
import enValidation from "../locales/en/validation.json";
import frCommon from "../locales/fr/common.json";
import frConstruction from "../locales/fr/construction.json";
import frFinance from "../locales/fr/finance.json";
import frField from "../locales/fr/field.json";
import frErrors from "../locales/fr/errors.json";
import frValidation from "../locales/fr/validation.json";
import arCommon from "../locales/ar/common.json";
import arConstruction from "../locales/ar/construction.json";
import arFinance from "../locales/ar/finance.json";
import arField from "../locales/ar/field.json";
import arErrors from "../locales/ar/errors.json";
import arValidation from "../locales/ar/validation.json";

const EN = Object.freeze({
  common: enCommon,
  construction: enConstruction,
  finance: enFinance,
  field: enField,
  errors: enErrors,
  validation: enValidation,
});
const FR = Object.freeze({
  common: frCommon,
  construction: frConstruction,
  finance: frFinance,
  field: frField,
  errors: frErrors,
  validation: frValidation,
});
const AR = Object.freeze({
  common: arCommon,
  construction: arConstruction,
  finance: arFinance,
  field: arField,
  errors: arErrors,
  validation: arValidation,
});

/** The en catalogs: the shape i18next's CustomTypeOptions types against. */
export const EN_RESOURCES = EN;

/** Every catalog: RESOURCES[locale][namespace][key] is an ICU message. */
export const RESOURCES = Object.freeze({ en: EN, fr: FR, ar: AR });
