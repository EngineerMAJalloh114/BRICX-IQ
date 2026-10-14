import common from "../locales/en/common.json" with { type: "json" };
import { defaultLocale } from "./index.js";

declare const stored: string;

export const save = common.save;
export const locale = defaultLocale;
export const parsed = new Date(stored);
export const half = Math.floor(7 / 2);
