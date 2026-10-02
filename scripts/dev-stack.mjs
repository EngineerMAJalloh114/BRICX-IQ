// `pnpm dev:up | dev:down | dev:reset` (ROADMAP P2-01, ADR 0034): the local
// Docker Compose stack in infrastructure/docker/compose.yml.
// - up: creates .env from .env.example when it is missing, or appends the
//   keys .env.example has and .env lacks (never overwriting a value) and
//   prints them; starts postgres and stops with a `pnpm dev:reset`
//   instruction if its volume predates the P2-02 bootstrap roles; then runs
//   each one-shot `*-init` service (s3-init creates the S3 bucket; P2-01b,
//   ADR 0036) and stops loudly if one fails; then starts every service and
//   waits until all are healthy (fails otherwise). Plain `docker compose up`
//   skips the one-shots (profile `init`), so it leaves s3 unhealthy: use
//   `pnpm dev:up`;
// - down: stops the stack and keeps its data volumes;
// - reset: deletes the stack AND its data volumes, but refuses unless it is
//   clearly the local bricx-dev stack on a local Docker daemon
//   (devResetRefusals in guards.mjs, proven by fixtures in check:workspace).
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  composeOneShots,
  devResetRefusals,
  missingBootstrapObjects,
  missingEnvEntries,
} from "./guards.mjs";

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

/** @param {string} env path of .env */
function completeEnv(env) {
  const example = readFileSync(path.join(root, ".env.example"), "utf8");
  if (!existsSync(env)) {
    copyFileSync(path.join(root, ".env.example"), env);
    console.log("dev:up: created .env from .env.example (local dev values)");
    return;
  }
  const current = readFileSync(env, "utf8");
  const missing = missingEnvEntries(example, current);
  if (missing.length === 0) return;
  const lead = current === "" || current.endsWith("\n") ? "" : "\n";
  appendFileSync(
    env,
    `${lead}\n# Added by pnpm dev:up from .env.example\n${missing
      .map((m) => m.line)
      .join("\n")}\n`,
  );
  console.log(
    `dev:up: added to .env from .env.example: ${missing.map((m) => m.key).join(", ")}`,
  );
}

// Asked inside the container, as the image's POSTGRES_USER, so this script
// never handles the bootstrap superuser's credentials (ADR 0035).
const bootstrapQuery = `SELECT json_build_object(
  'roles', (SELECT coalesce(json_agg(rolname), '[]') FROM pg_roles),
  'schemas', (SELECT coalesce(json_agg(nspname), '[]') FROM pg_namespace),
  'publications', (SELECT coalesce(json_agg(pubname), '[]') FROM pg_publication))`;

/** What the running postgres lacks of the P2-02 bootstrap objects. */
function missingFromVolume() {
  /** @type {unknown} */
  const found = JSON.parse(
    dockerOutput([
      ...compose,
      "exec",
      "-T",
      "postgres",
      "sh",
      "-c",
      'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$0"',
      bootstrapQuery,
    ]),
  );
  return missingBootstrapObjects(
    /** @type {{ roles: string[], schemas: string[], publications: string[] }} */ (
      found
    ),
  );
}

function up() {
  completeEnv(path.join(root, ".env"));
  const postgres = docker([
    ...compose,
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    waitSeconds,
    "postgres",
  ]);
  if (postgres !== 0) return postgres;
  const missing = missingFromVolume();
  if (missing.length > 0) {
    console.error(
      `dev:up STOPPED: this Postgres volume was created before the database bootstrap roles (P2-02) existed; it lacks ${missing.join(", ")}.`,
    );
    console.error(
      "Init scripts run only on an empty volume. Run `pnpm dev:reset` (deletes all local stack data), then `pnpm dev:up`.",
    );
    return 1;
  }
  // `run` starts what the one-shot depends on (s3) and returns its exit
  // code. Run, not `up`: an exited one-shot makes every later `up --wait`
  // exit 1 (Compose v5.3.1).
  const composeText = readFileSync(
    path.join(root, "infrastructure/docker/compose.yml"),
    "utf8",
  );
  for (const oneShot of composeOneShots(composeText)) {
    const status = docker([...compose, "run", "--rm", oneShot]);
    if (status !== 0) {
      console.error(
        `dev:up FAILED: the one-shot ${oneShot} exited with ${String(status)}; its output is above (ADR 0036).`,
      );
      return status;
    }
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
