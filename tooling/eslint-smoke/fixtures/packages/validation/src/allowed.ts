import { defaultLocale } from "@bricx/i18n";
import { idPrefix } from "@bricx/ids";
import { minorUnitsPerMajor } from "@bricx/money";
import countries from "../data/countries.json" with { type: "json" };
import { validationMarker } from "./index.js";

declare const stored: string;

export const locale = defaultLocale;
export const prefix = idPrefix;
export const factor = minorUnitsPerMajor;
export const codes = countries.codes;
export const marker = validationMarker;
export const parsed = new Date(stored);
