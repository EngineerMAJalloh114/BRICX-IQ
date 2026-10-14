import type { DefaultLocale } from "@bricx/i18n";
import { idPrefix } from "@bricx/ids";
import { permissionsMarker } from "./index.js";

declare const stored: string;

export const locale: DefaultLocale = "en";
export const prefix = idPrefix;
export const marker = permissionsMarker;
export const parsed = new Date(stored);
