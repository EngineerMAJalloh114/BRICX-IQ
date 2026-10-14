import type { DefaultLocale } from "@bricx/i18n";
import { idPrefix } from "@bricx/ids";
import { minorUnitsPerMajor } from "@bricx/money";

declare const occurredAt: string;

export const locale: DefaultLocale = "en";
export const prefix = idPrefix;
export const factor = minorUnitsPerMajor;
export const parsed = new Date(occurredAt);
