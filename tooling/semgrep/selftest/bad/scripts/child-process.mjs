// Known-bad: commands built from strings run through a shell.
import { exec, execSync, spawn, spawnSync } from "node:child_process";

export function bad(branch, file) {
  spawn("git", ["log", branch], { shell: true });
  spawnSync("ls", [file], { cwd: ".", shell: process.env.SHELL });
  exec(`git checkout ${branch}`);
  execSync("cat " + file);
  spawn("sh", ["-c", `rm ${file}`]);
}

// Known-bad: the same through a namespace import.
import * as cp from "node:child_process";
export function alsoBad(file) {
  cp.execSync(`cat ${file}`);
}
