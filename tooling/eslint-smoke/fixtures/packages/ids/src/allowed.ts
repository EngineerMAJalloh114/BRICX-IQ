import { minorUnitsPerMajor } from "@bricx/money";

declare const count: string;
declare const pageSize: string;

export const factor = minorUnitsPerMajor;
export const createdAt = Date.now();
export const today = new Date();
export const rows = Number(count);
export const size = Number.parseInt(pageSize, 10);
