import { sep } from "node:path";
import { version } from "typescript";
import { tableName } from "@bricx/db";

export const separator = sep;
export const compilerVersion = version;
export const table = tableName;
export const now = Date.now();
export const roll = Math.random();
