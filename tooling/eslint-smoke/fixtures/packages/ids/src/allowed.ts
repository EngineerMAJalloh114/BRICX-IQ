import { idPrefix } from "./index.js";

declare const stored: string;

export const prefix = idPrefix;
export const parsed = new Date(stored);
export const half = Math.floor(7 / 2);
