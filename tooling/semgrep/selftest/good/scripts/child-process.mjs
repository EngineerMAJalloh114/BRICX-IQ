// Known-good: argument arrays, no shell.
import { execFileSync, spawn, spawnSync } from "node:child_process";

export function good(branch, file) {
  spawn("git", ["log", branch], { shell: false });
  spawnSync("ls", [file], { cwd: "." });
  execFileSync("git", ["checkout", branch]);
}

// Known-good: RegExp.prototype.exec is not child_process.
export function notAProcess(line) {
  return /^v(\d+)$/.exec(line)?.[1];
}
