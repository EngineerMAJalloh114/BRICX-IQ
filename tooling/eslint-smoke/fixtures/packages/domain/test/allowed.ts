import { sep } from "node:path";
import { version } from "typescript";
import { defaultLocale } from "@bricx/i18n";

export const separator = sep;
export const compilerVersion = version;
export const locale = defaultLocale;
export const now = Date.now();
export const roll = Math.random();
