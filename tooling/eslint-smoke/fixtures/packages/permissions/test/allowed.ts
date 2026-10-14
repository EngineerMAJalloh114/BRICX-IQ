import { sep } from "node:path";
import { version } from "typescript";
import { tableName } from "../../db/src/index.js";

export const separator = sep;
export const compilerVersion = version;
export const table = tableName;
export const now = Date.now();
export const roll = Math.random();
