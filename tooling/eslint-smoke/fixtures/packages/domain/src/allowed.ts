import { idPrefix } from "@bricx/ids";
import { minorUnitsPerMajor } from "@bricx/money";

declare const occurredAt: string;

export const prefix = idPrefix;
export const factor = minorUnitsPerMajor;
export const parsed = new Date(occurredAt);
