import { idPrefix } from "@bricx/ids";
import iso4217 from "../data/iso4217.json" with { type: "json" };
import { minorUnitsPerMajor } from "./index.js";

declare const stored: string;

export const prefix = idPrefix;
export const factor = minorUnitsPerMajor;
export const codes = iso4217.currencies.map((c) => c.code);
export const parsed = new Date(stored);
export const half = Math.floor(7 / 2);
