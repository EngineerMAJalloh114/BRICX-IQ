// `pnpm dev:up | dev:down | dev:reset` (ROADMAP P2-01, ADR 0034): the local
// Docker Compose stack in infrastructure/docker/compose.yml.
// - up: creates .env from .env.example when it is missing, then starts every
//   service and waits until all are healthy (fails otherwise);
// - down: stops the stack and keeps its data volumes;
// - reset: deletes the stack AND its data volumes, but refuses unless it is
//   clearly the local bricx-dev stack on a local Docker daemon
//   (devResetRefusals in guards.mjs, proven by fixtures in check:workspace).
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { devResetRefusals } from "./guards.mjs";

const root = path.resolve(import.meta.dirname, "..");
const project = "bricx-dev";
const compose = [
  "compose",
  "--env-file",
  path.join(root, ".env"),
  "-f",
  path.join(root, "infrastructure/docker/compose.yml"),
  "-p",
  project,
];
// ClamAV's healthcheck allows a 6-minute start period; the budget for a
// cold start is 3 minutes (P2-01 "Done when"), measured, not enforced here.
const waitSeconds = "600";

/** @param {string[]} args */
function docker(args) {
  const result = spawnSync("docker", args, { cwd: root, stdio: "inherit" });
  if (result.error) {
    console.error(`dev-stack: cannot run docker: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

/** @param {string[]} args */
const dockerOutput = (args) =>
  execFileSync("docker", args, { cwd: root, encoding: "utf8" }).trim();

function up() {
  const env = path.join(root, ".env");
  if (!existsSync(env)) {
    copyFileSync(path.join(root, ".env.example"), env);
    console.log("dev:up: created .env from .env.example (local dev values)");
  }
  return docker([
    ...compose,
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    waitSeconds,
    "--remove-orphans",
  ]);
}

function down() {
  return docker([...compose, "down", "--remove-orphans"]);
}

/** @param {string[]} refusals */
function refuse(refusals) {
  for (const refusal of refusals) console.error(`- ${refusal}`);
  console.error(
    "dev:reset REFUSED: it only deletes the local bricx-dev stack on a local Docker daemon",
  );
  return 1;
}

function reset() {
  if (!existsSync(path.join(root, ".env"))) {
    console.error("dev:reset REFUSED: no .env, so no local stack to reset");
    return 1;
  }
  // Checked before anything talks to the daemon, so a remote host is never
  // even queried.
  /** @type {unknown} */
  const config = JSON.parse(
    dockerOutput([...compose, "config", "--format", "json"]),
  );
  const target = {
    dockerHost: process.env.DOCKER_HOST,
    contextEndpoint: dockerOutput([
      "context",
      "inspect",
      "--format",
      "{{.Endpoints.docker.Host}}",
    ]),
    projectName: /** @type {{ name?: string }} */ (config).name ?? "",
  };
  const early = devResetRefusals({ ...target, volumes: [] });
  if (early.length > 0) return refuse(early);

  const names = dockerOutput([
    "volume",
    "ls",
    "--quiet",
    "--filter",
    `label=com.docker.compose.project=${project}`,
  ])
    .split("\n")
    .filter((name) => name !== "");
  /** @type {unknown} */
  const inspected =
    names.length === 0
      ? []
      : JSON.parse(dockerOutput(["volume", "inspect", ...names]));
  const volumes =
    /** @type {{ Name: string, Labels: Record<string, string> | null }[]} */ (
      inspected
    ).map((v) => ({ name: v.Name, labels: v.Labels ?? {} }));
  const refusals = devResetRefusals({ ...target, volumes });
  if (refusals.length > 0) return refuse(refusals);
  console.log(
    `dev:reset: deleting the local bricx-dev stack and ${String(volumes.length)} labelled volumes`,
  );
  return docker([...compose, "down", "--volumes", "--remove-orphans"]);
}

/** @type {Record<string, () => number>} */
const commands = { up, down, reset };
const command = commands[process.argv[2] ?? ""];
if (!command) {
  console.error("usage: node scripts/dev-stack.mjs up|down|reset");
  process.exit(2);
}
process.exit(command());
