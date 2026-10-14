import { sep } from "node:path";
import { version } from "typescript";
import { minorUnitsPerMajor } from "../../money/src/index.js";

export const separator = sep;
export const compilerVersion = version;
export const factor = minorUnitsPerMajor;
export const now = Date.now();
export const roll = Math.random();
