// `pnpm --filter @bricx/permissions gen` writes generated/ from the
// catalogue, the role bundles and the SoD rules (ADR 0048).
// `gen --check` exits 1 when a committed file is missing or stale (the
// same check generate.test.ts runs in `pnpm verify`).
import path from "node:path";
import process from "node:process";
import { checkGenerated, writeGenerated } from "./gen-lib.mjs";

const dir = path.join(import.meta.dirname, "../generated");
if (process.argv.includes("--check")) {
  const problems = await checkGenerated(dir);
  if (problems.length > 0) {
    process.stderr.write(
      `${problems.join("\n")}\nrun: pnpm --filter @bricx/permissions gen\n`,
    );
    process.exit(1);
  }
  process.stdout.write("permissions: generated/ is current\n");
} else {
  const written = await writeGenerated(dir);
  process.stdout.write(
    `wrote ${written.map((f) => `generated/${f}`).join(", ")}\n`,
  );
}
