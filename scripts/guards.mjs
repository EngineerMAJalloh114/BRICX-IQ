// Pure checks used by check-workspace-scripts.mjs (P1-06, ADR 0031). Each
// takes file contents and returns a list of problems, so the fixtures in
// scripts/guard-fixtures/ can prove every rule fails when broken.

import { createHash } from "node:crypto";
import path from "node:path";

/** Dependency fields whose entries must be exact and allow-listed. */
export const dependencyFields = /** @type {const} */ ([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
]);

/**
 * @typedef {Partial<Record<(typeof dependencyFields)[number], Record<string, string>>>} Manifest
 */

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Every dependency version must be an exact semver (`save-exact`, ADR 0023);
 * `workspace:*` links are the only exception.
 * @param {Manifest} manifest
 * @param {string} label
 * @returns {string[]}
 */
export function exactPinProblems(manifest, label) {
  /** @type {string[]} */
  const problems = [];
  for (const field of dependencyFields) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (version === "workspace:*") continue;
      if (!exactVersion.test(version)) {
        problems.push(
          `${label}: ${field} ${name} "${version}" is not an exact version (ADR 0023: pin exact versions)`,
        );
      }
    }
  }
  return problems;
}

const packageName = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

/**
 * Package names allowed by docs/DEPENDENCIES.md: every backticked npm name
 * in the first cell of a table row, before any parenthesised note.
 * @param {string} markdown
 * @returns {Set<string>}
 */
export function allowedPackageNames(markdown) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const firstCell = line.split("|")[1] ?? "";
    const beforeNote = firstCell.split("(")[0] ?? "";
    for (const match of beforeNote.matchAll(/`([^`]+)`/g)) {
      const name = match[1] ?? "";
      if (packageName.test(name)) names.add(name);
    }
  }
  return names;
}

/**
 * Every dependency name must be listed in docs/DEPENDENCIES.md (ADR 0023);
 * internal `workspace:*` packages are exempt.
 * @param {Manifest} manifest
 * @param {string} label
 * @param {Set<string>} allowed
 * @returns {string[]}
 */
export function unlistedDependencyProblems(manifest, label, allowed) {
  /** @type {string[]} */
  const problems = [];
  for (const field of dependencyFields) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (version === "workspace:*" || allowed.has(name)) continue;
      problems.push(
        `${label}: ${field} ${name} is not listed in docs/DEPENDENCIES.md (ADR 0023: add it there, with an ADR, first)`,
      );
    }
  }
  return problems;
}

const shaPinned =
  /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40} # v\d+\.\d+\.\d+$/;
const digestPinned = /^docker:\/\/[\w./-]+(?::[\w.-]+)?@sha256:[0-9a-f]{64}$/;
const requiredEnv = [
  'HUSKY: "0"',
  'TURBO_TELEMETRY_DISABLED: "1"',
  "TURBO_CACHE: local:rw",
];

/**
 * Security rules for a GitHub Actions workflow or composite action
 * (ADR 0031). Line-based: our workflows are written in this plain style,
 * and anything the rules cannot read is reported rather than skipped.
 * @param {string} text
 * @param {string} label
 * @param {"workflow" | "action"} kind
 * @returns {{ problems: string[], uses: number }}
 */
export function workflowProblems(text, label, kind) {
  /** @type {string[]} */
  const problems = [];
  let uses = 0;
  const lines = text.split("\n");
  /** @type {number | undefined} indentation of the open `run: |` key */
  let runIndent;
  lines.forEach((raw, index) => {
    const where = `${label}:${String(index + 1)}`;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (runIndent !== undefined) {
      if (line === "" || indent > runIndent) {
        if (line.includes("${{")) {
          problems.push(
            `${where}: \${{ }} inside a run: script; pass it through env: instead`,
          );
        }
        return;
      }
      runIndent = undefined;
    }
    if (line.startsWith("#")) return;
    if (/\bpull_request_target\b/.test(line)) {
      problems.push(`${where}: pull_request_target is forbidden`);
    }
    if (/^(?:- )?if:/.test(line)) {
      problems.push(
        `${where}: if: conditions are not allowed; a skipped job or step counts as passing (no job may be skipped or pass on zero work)`,
      );
    }
    if (/\bTURBO_(?:TOKEN|TEAM)\b/.test(line)) {
      problems.push(
        `${where}: Turbo remote cache is off (no TURBO_TOKEN/TURBO_TEAM)`,
      );
    }
    const run = /^(?:- )?run:\s*(.*)$/.exec(line);
    if (run) {
      const value = run[1] ?? "";
      if (/^[|>][-+]?$/.test(value)) {
        runIndent = indent + (line.startsWith("- ") ? 2 : 0);
      } else if (value.includes("${{")) {
        problems.push(
          `${where}: \${{ }} inside a run: script; pass it through env: instead`,
        );
      }
    }
    const use = /^(?:- )?uses:\s*(.*)$/.exec(line);
    if (use) {
      uses += 1;
      const target = use[1] ?? "";
      if (
        !target.startsWith("./") &&
        !shaPinned.test(target) &&
        !digestPinned.test(target)
      ) {
        problems.push(
          `${where}: "${target}" must be pinned by full commit SHA with a version comment (owner/repo@<40 hex> # vX.Y.Z)`,
        );
      }
    }
    if (/^permissions:/.test(line) && indent > 0) {
      problems.push(
        `${where}: job-level permissions are not allowed; the top-level contents: read is the only grant`,
      );
    }
  });
  if (kind === "workflow") {
    const top = lines.findIndex((l) => l.startsWith("permissions:"));
    const grant = lines
      .slice(top + 1)
      .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
    const body = [];
    for (const l of grant) {
      if (!l.startsWith(" ")) break;
      body.push(l.trim());
    }
    if (
      top === -1 ||
      lines[top]?.trim() !== "permissions:" ||
      JSON.stringify(body) !== JSON.stringify(["contents: read"])
    ) {
      problems.push(
        `${label}: top-level permissions must be exactly "contents: read"`,
      );
    }
    for (const env of requiredEnv) {
      if (!lines.some((l) => l.trim() === env)) {
        problems.push(`${label}: must set ${env} in env`);
      }
    }
  }
  return { problems, uses };
}

const imageRef = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+:[\w.-]+$/;

/**
 * Container images allowed by docs/DEPENDENCIES.md: every backticked
 * `repo:tag` in the first cell of a table row (P2-01, ADR 0034).
 * @param {string} markdown
 * @returns {Set<string>}
 */
export function allowedImageRefs(markdown) {
  /** @type {Set<string>} */
  const refs = new Set();
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const firstCell = line.split("|")[1] ?? "";
    for (const match of firstCell.matchAll(/`([^`]+)`/g)) {
      const ref = match[1] ?? "";
      if (imageRef.test(ref)) refs.add(ref);
    }
  }
  return refs;
}

const pinnedImage =
  /^([a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+):([\w.-]+)@sha256:[0-9a-f]{64}$/;
const loopbackPort = /^127\.0\.0\.1:\d+:\d+(?:\/(?:tcp|udp))?$/;
const blockScalar = /:\s*[|>][-+]?\d*$/;

/** @param {string} value */
const unquote = (value) => value.replace(/^(["'])(.*)\1$/, "$2");

/**
 * Minimum healthcheck start_period, in seconds, per compose service
 * (P2-01c, ADR 0042). Docker counts no failures inside start_period, so a
 * shorter window marks a slow but healthy cold start unhealthy; all three
 * failed `pnpm dev:up` on the owner's machine. Worst measured, from
 * container start: otel-lgtm (Grafana) 166 s, keycloak 182 s, powersync 93 s.
 */
export const startPeriodFloors = new Map([
  ["otel-lgtm", 300],
  ["keycloak", 300],
  ["powersync", 180],
]);

const durationUnits = /** @type {Record<string, number>} */ ({
  h: 3600,
  m: 60,
  s: 1,
  ms: 0.001,
  us: 0.000001,
  ns: 0.000000001,
});

/**
 * Seconds in a literal compose duration ("300s", "5m", "4m59s"), or
 * undefined when it is not one (a bare number, an interpolation, anything
 * else), so the floor fails closed on what it cannot read.
 * @param {string} value
 * @returns {number | undefined}
 */
export function composeDurationSeconds(value) {
  if (!/^(?:\d+(?:\.\d+)?(?:ms|us|ns|h|m|s))+$/.test(value)) return undefined;
  let seconds = 0;
  for (const [, quantity, unit] of value.matchAll(
    /(\d+(?:\.\d+)?)(ms|us|ns|h|m|s)/g,
  )) {
    seconds += Number(quantity) * (durationUnits[unit ?? ""] ?? Number.NaN);
  }
  return Number.isFinite(seconds) ? seconds : undefined;
}

// Built from parts so the guard does not flag its own source (ADR 0035).
export const superuserMarker = ["POSTGRES", "SUPERUSER", ""].join("_");

/**
 * Rules for the local Docker Compose stack (P2-01, ADR 0034). Line-based,
 * like workflowProblems: the compose file is written in plain block style,
 * and anything these rules cannot read (anchors, aliases, merge keys, flow
 * style, include/extends) is reported rather than skipped. Container escape
 * routes are refused (architect review 2026-10-02): privileged mode, host
 * namespaces, added capabilities, security options, devices, bind mounts
 * from outside the compose file's own directory (docker.sock included),
 * volume driver options, and top-level secrets/configs. It blocks the common
 * routes and fails closed; it does not defend against every escape.
 * The bootstrap superuser variables may appear only inside the postgres
 * service, comments included (P2-02, ADR 0035). A service in
 * startPeriodFloors needs a literal healthcheck start_period at or above its
 * floor; missing, interpolated or unreadable values fail (P2-01c, ADR 0042).
 * @param {string} text
 * @param {string} label
 * @param {Set<string>} allowedImages repo:tag pairs from DEPENDENCIES.md
 * @returns {{ problems: string[], services: number, names: string[] }}
 */
export function composeProblems(text, label, allowedImages) {
  /** @type {string[]} */
  const problems = [];
  /**
   * @typedef {{ name: string, image: boolean, healthcheck: boolean,
   *   profiles: string[] | undefined, restart: string | undefined,
   *   dependsOn: boolean, ports: boolean,
   *   startPeriod: string | undefined }} ComposeService
   */
  /** @type {ComposeService[]} */
  const services = [];
  /** @type {ComposeService | undefined} */
  let service;
  let inServices = false;
  /** @type {string | undefined} the open indent-4 key of the current service */
  let serviceKey;
  /** @type {number | undefined} indentation of an open block scalar key */
  let scalarIndent;
  /** @type {string | undefined} the open top-level key */
  let topKey;
  text.split("\n").forEach((raw, index) => {
    const where = `${label}:${String(index + 1)}`;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (
      raw.includes(superuserMarker) &&
      !(inServices && service?.name === "postgres" && indent >= 4)
    ) {
      problems.push(
        `${where}: the bootstrap superuser variables (${superuserMarker}*) may be used only inside the postgres service (ADR 0035)`,
      );
    }
    if (scalarIndent !== undefined) {
      if (line === "" || indent > scalarIndent) return;
      scalarIndent = undefined;
    }
    if (line === "" || line.startsWith("#")) return;
    if (/^\t/.test(raw)) {
      problems.push(`${where}: tabs are not allowed; indent with spaces`);
      return;
    }
    if (
      /(?:^|\s)&[\w-]/.test(line) ||
      /(?::|^-)\s+\*[\w-]/.test(line) ||
      /^(?:- )?<<\s*:/.test(line)
    ) {
      problems.push(
        `${where}: YAML anchors, aliases and merge keys are not allowed`,
      );
    }
    const value = /^(?:- )?[\w.-]+:\s*(.*)$/.exec(line)?.[1] ?? "";
    if (/^[{[]/.test(value) && inServices) {
      problems.push(
        `${where}: flow style is not allowed; use block style (one item per line)`,
      );
    }
    if (blockScalar.test(line)) scalarIndent = indent;

    if (indent === 0) {
      inServices = line === "services:";
      service = undefined;
      topKey = /^([\w.-]+):/.exec(line)?.[1];
      if (/^(?:include|extends):/.test(line)) {
        problems.push(`${where}: include and extends are not allowed`);
      }
      if (/^(?:secrets|configs):/.test(line)) {
        problems.push(
          `${where}: top-level secrets and configs are not allowed (they mount host files)`,
        );
      }
      return;
    }
    if (topKey === "volumes" && indent === 4) {
      const key = /^([\w.-]+):/.exec(line)?.[1];
      if (key !== "labels") {
        problems.push(
          `${where}: volume option "${key ?? line}" is not allowed; named volumes take labels only (driver options can bind host paths)`,
        );
      }
      return;
    }
    if (!inServices) return;
    if (indent === 2) {
      const name = /^([\w.-]+):$/.exec(line)?.[1];
      if (name === undefined) {
        problems.push(`${where}: cannot read service "${line}"`);
        return;
      }
      service = {
        name,
        image: false,
        healthcheck: false,
        profiles: undefined,
        restart: undefined,
        dependsOn: false,
        ports: false,
        startPeriod: undefined,
      };
      services.push(service);
      serviceKey = undefined;
      return;
    }
    if (service === undefined) return;
    const at = `${where}: service ${service.name}`;
    if (indent === 4) {
      serviceKey = /^([\w.-]+):/.exec(line)?.[1];
      if (serviceKey === undefined) {
        problems.push(
          `${at}: cannot read "${line}"; indent list items under their key`,
        );
        return;
      }
      switch (serviceKey) {
        case "image": {
          service.image = true;
          const image = unquote(value);
          const pinned = pinnedImage.exec(image);
          if (!pinned) {
            problems.push(
              `${at}: image "${image}" must be pinned as repo:tag@sha256:<64 hex>`,
            );
          } else if (pinned[2]?.toLowerCase() === "latest") {
            problems.push(
              `${at}: image "${image}" must not use the latest tag`,
            );
          } else if (
            !allowedImages.has(`${pinned[1] ?? ""}:${pinned[2] ?? ""}`)
          ) {
            problems.push(
              `${at}: image ${pinned[1] ?? ""}:${pinned[2] ?? ""} is not listed in docs/DEPENDENCIES.md section 8 (ADR 0023)`,
            );
          }
          break;
        }
        case "build":
          problems.push(`${at}: build: is not allowed; use a pinned image`);
          break;
        case "extends":
          problems.push(`${at}: include and extends are not allowed`);
          break;
        case "network_mode":
          if (unquote(value) === "host") {
            problems.push(
              `${at}: network_mode: host is not allowed (it bypasses the 127.0.0.1 port binding)`,
            );
          }
          break;
        case "healthcheck":
          service.healthcheck = true;
          break;
        case "profiles":
          service.profiles = [];
          if (value !== "") {
            problems.push(`${at}: list profiles one per line`);
          }
          break;
        case "restart":
          service.restart = unquote(value);
          break;
        case "depends_on":
          service.dependsOn = true;
          break;
        case "ports":
          service.ports = true;
          break;
        case "privileged":
          if (unquote(value) !== "false") {
            problems.push(`${at}: privileged mode is not allowed`);
          }
          break;
        case "pid":
        case "ipc":
        case "userns_mode":
        case "uts":
        case "cgroup":
          problems.push(
            `${at}: ${serviceKey}: is not allowed (no shared or host namespaces)`,
          );
          break;
        case "cap_add":
        case "security_opt":
        case "devices":
        case "volumes_from":
          problems.push(
            `${at}: ${serviceKey} is not allowed (container escape route)`,
          );
          break;
        default:
          break;
      }
      return;
    }
    if (serviceKey === "volumes") {
      const item = /^- (.*)$/.exec(line)?.[1];
      if (item === undefined) return;
      if (/^[\w.-]+:(?:\s|$)/.test(item)) {
        problems.push(
          `${at}: use the short volume syntax "SOURCE:TARGET[:MODE]"`,
        );
        return;
      }
      const source = unquote(item).split(":")[0] ?? "";
      const named = /^[A-Za-z0-9][\w.-]*$/.test(source);
      const normalized = path.posix.normalize(source);
      const inside =
        /^\.(?:\/|$)/.test(source) &&
        !source.includes("$") &&
        normalized !== ".." &&
        !normalized.startsWith("../");
      if (!named && !inside) {
        problems.push(
          `${at}: bind mount source "${source}" must be a named volume or a path inside the compose file's directory (./...)`,
        );
      }
      return;
    }
    if (serviceKey === "ports") {
      const item = /^- (.*)$/.exec(line)?.[1];
      if (item !== undefined) {
        const port = unquote(item);
        if (/^[\w.-]+:\s/.test(item) || /^[\w.-]+:$/.test(item)) {
          problems.push(
            `${at}: use the short port syntax "127.0.0.1:HOST:CONTAINER"`,
          );
        } else if (!loopbackPort.test(port)) {
          problems.push(
            `${at}: port "${port}" must be bound to 127.0.0.1 ("127.0.0.1:HOST:CONTAINER")`,
          );
        }
      }
      return;
    }
    if (serviceKey === "profiles") {
      const item = /^- (.*)$/.exec(line)?.[1];
      if (item === undefined) {
        problems.push(`${at}: cannot read profiles entry "${line}"`);
      } else {
        service.profiles?.push(unquote(item));
      }
      return;
    }
    if (serviceKey === "healthcheck") {
      const disabled =
        (indent === 6 && /^disable:\s*(?:true|"true"|'true')$/.test(line)) ||
        /^test:\s*\[?\s*["']?NONE["']?\s*\]?$/.test(line) ||
        /^- ["']?NONE["']?$/.test(line);
      if (disabled) problems.push(`${at}: healthcheck is disabled`);
      const startPeriod =
        indent === 6 ? /^start_period:\s*(.*)$/.exec(line)?.[1] : undefined;
      if (startPeriod !== undefined) service.startPeriod = unquote(startPeriod);
    }
  });
  for (const s of services) {
    if (!s.image) problems.push(`${label}: service ${s.name} has no image`);
    const floor = startPeriodFloors.get(s.name);
    if (floor !== undefined) {
      const at = `${label}: service ${s.name}`;
      const seconds =
        s.startPeriod === undefined
          ? undefined
          : composeDurationSeconds(s.startPeriod);
      if (s.startPeriod === undefined) {
        problems.push(
          `${at} needs a healthcheck start_period of at least ${String(floor)}s (ADR 0042)`,
        );
      } else if (seconds === undefined) {
        problems.push(
          `${at}: cannot read healthcheck start_period "${s.startPeriod}"; write a literal duration such as ${String(floor)}s or 5m (ADR 0042)`,
        );
      } else if (seconds < floor) {
        problems.push(
          `${at}: healthcheck start_period ${s.startPeriod} is below the ${String(floor)}s floor (ADR 0042)`,
        );
      }
    }
    const oneShot = s.name.endsWith("-init") || s.profiles !== undefined;
    if (!oneShot) {
      if (!s.healthcheck) {
        problems.push(`${label}: service ${s.name} has no healthcheck`);
      }
      continue;
    }
    // A one-shot exits, so it has no healthcheck; these rules keep that
    // exemption narrow (P2-01b, ADR 0036).
    const at = `${label}: one-shot service ${s.name}`;
    if (!s.name.endsWith("-init")) {
      problems.push(
        `${at}: profiles are allowed only on one-shot *-init services (ADR 0036)`,
      );
    }
    if (s.profiles?.length !== 1 || s.profiles[0] !== "init") {
      problems.push(`${at}: needs exactly one profile, init (ADR 0036)`);
    }
    if (s.restart !== "no") {
      problems.push(`${at}: needs restart: "no" (ADR 0036)`);
    }
    if (!s.dependsOn) {
      problems.push(
        `${at}: needs depends_on naming the service it initialises (ADR 0036)`,
      );
    }
    if (s.ports) {
      problems.push(`${at}: must not publish ports (ADR 0036)`);
    }
    if (s.healthcheck) {
      problems.push(
        `${at}: must not have a healthcheck; a one-shot's healthcheck is hollow, the service it initialises proves the result (ADR 0036)`,
      );
    }
  }
  if (services.length === 0) {
    problems.push(`${label}: no services found; the guard did no work`);
  }
  return {
    problems,
    services: services.length,
    names: services.map((s) => s.name),
  };
}

/**
 * @typedef {{
 *   dockerHost?: string | undefined,
 *   contextEndpoint: string,
 *   projectName: string,
 *   volumes: { name: string, labels: Record<string, string> }[],
 * }} DevResetState
 */

/**
 * Why `pnpm dev:reset` must refuse to delete anything (P2-01, ADR 0034):
 * it only ever wipes the local bricx-dev stack on a local Docker daemon.
 * @param {DevResetState} state
 * @returns {string[]}
 */
export function devResetRefusals(state) {
  /** @type {string[]} */
  const refusals = [];
  if (state.dockerHost && !state.dockerHost.startsWith("unix://")) {
    refusals.push(
      `DOCKER_HOST "${state.dockerHost}" is not a local unix socket`,
    );
  }
  if (!state.contextEndpoint.startsWith("unix://")) {
    refusals.push(
      `the docker context endpoint "${state.contextEndpoint}" is not a local unix socket`,
    );
  }
  if (state.projectName !== "bricx-dev") {
    refusals.push(
      `the compose project is "${state.projectName}", not "bricx-dev"`,
    );
  }
  for (const volume of state.volumes) {
    if (
      volume.labels["com.bricx.stack"] !== "local-dev" ||
      !volume.name.startsWith("bricx-dev_")
    ) {
      refusals.push(
        `volume ${volume.name} is not a bricx-dev volume labelled com.bricx.stack=local-dev`,
      );
    }
  }
  return refusals;
}

/**
 * Files outside compose.yml that may name the bootstrap superuser
 * variables (P2-02, ADR 0035): .env.example defines them, Markdown
 * documents them, and the guard fixtures exercise the rule.
 * @param {string} file repo-relative path
 */
const superuserAllowed = (file) =>
  file === ".env.example" ||
  file.endsWith(".md") ||
  file.startsWith("scripts/guard-fixtures/");

/**
 * The bootstrap superuser is for bootstrap only (ADR 0035): no tracked file
 * other than compose.yml (checked per service by composeProblems),
 * .env.example, Markdown and the guard fixtures may reference its
 * variables.
 * @param {{ file: string, text: string }[]} files repo-relative paths
 * @returns {string[]}
 */
export function superuserReferenceProblems(files) {
  /** @type {string[]} */
  const problems = [];
  for (const { file, text } of files) {
    if (
      file === "infrastructure/docker/compose.yml" ||
      superuserAllowed(file)
    ) {
      continue;
    }
    text.split("\n").forEach((line, index) => {
      if (line.includes(superuserMarker)) {
        problems.push(
          `${file}:${String(index + 1)}: references the bootstrap superuser variables (${superuserMarker}*); only the postgres service in compose.yml may use them (ADR 0035)`,
        );
      }
    });
  }
  return problems;
}

// Built from parts so this file does not trip its own rule.
const loadEnvFileMarker = ["load", "EnvFile"].join("");
const envFileFlag = ["--env", "file"].join("-");
const productionEnvMarker = [".env", "production"].join(".");

/**
 * Env files are loaded only by dev entry points (P2-03, ADR 0039):
 * - nothing under packages/ uses Node's env-file loading (the process
 *   method or the CLI flag, see the markers above): @bricx/config's
 *   loaders read only the environment they are given;
 * - no file that loads an env file mentions the production env file
 *   anywhere, so a multi-line call cannot hide it.
 * Markdown and the guard fixtures are exempt.
 * @param {{ file: string, text: string }[]} files repo-relative paths
 * @returns {string[]}
 */
export function envFileLoadProblems(files) {
  /** @type {string[]} */
  const problems = [];
  for (const { file, text } of files) {
    if (file.endsWith(".md") || file.startsWith("scripts/guard-fixtures/")) {
      continue;
    }
    const lines = text.split("\n");
    const loads = (/** @type {string} */ line) =>
      line.includes(loadEnvFileMarker) || line.includes(envFileFlag);
    lines.forEach((line, index) => {
      if (file.startsWith("packages/") && loads(line)) {
        problems.push(
          `${file}:${String(index + 1)}: packages/ never load an env file (${loadEnvFileMarker} or ${envFileFlag}); only dev entry points do (ADR 0039)`,
        );
      }
    });
    if (lines.some(loads)) {
      lines.forEach((line, index) => {
        if (line.includes(productionEnvMarker)) {
          problems.push(
            `${file}:${String(index + 1)}: a file that loads env files must never name ${productionEnvMarker}* (ADR 0039)`,
          );
        }
      });
    }
  }
  return problems;
}

/**
 * The `KEY=value` lines of a dotenv file, by key (comments and blank lines
 * skipped; a later duplicate does not replace the first).
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function envEntries(text) {
  /** @type {Map<string, string>} */
  const entries = new Map();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const key = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (key !== undefined && !entries.has(key)) entries.set(key, line);
  }
  return entries;
}

/**
 * Lines `pnpm dev:up` appends to an existing .env: every key in
 * .env.example that .env lacks, exactly as .env.example has it. Keys that
 * .env already has are never touched (P2-02).
 * @param {string} example .env.example
 * @param {string} current the existing .env
 * @returns {{ key: string, line: string }[]}
 */
export function missingEnvEntries(example, current) {
  const have = envEntries(current);
  return [...envEntries(example)]
    .filter(([key]) => !have.has(key))
    .map(([key, line]) => ({ key, line }));
}

/** What 01-bootstrap.sh creates; `pnpm dev:up` checks it exists. */
export const bootstrapObjects = {
  roles: [
    "bricx_owner",
    "bricx_app",
    "bricx_readonly",
    "powersync_repl",
    "powersync_storage_owner",
  ],
  schemas: ["bricx", "extensions", "bricx_migrations"],
  publications: ["powersync"],
};

/**
 * What a Postgres volume created before P2-02 (or by a later, changed init
 * script) lacks; empty when the bootstrap objects all exist.
 * @param {{ roles: string[], schemas: string[], publications: string[] }} found
 * @returns {string[]}
 */
export function missingBootstrapObjects(found) {
  return [
    ...bootstrapObjects.roles
      .filter((r) => !found.roles.includes(r))
      .map((r) => `role ${r}`),
    ...bootstrapObjects.schemas
      .filter((s) => !found.schemas.includes(s))
      .map((s) => `schema ${s}`),
    ...bootstrapObjects.publications
      .filter((p) => !found.publications.includes(p))
      .map((p) => `publication ${p}`),
  ];
}

/**
 * The image of one compose service, as written (repo:tag@sha256:digest),
 * so tests run the image compose.yml pins without a second copy of it.
 * @param {string} text compose.yml
 * @param {string} name service name
 * @returns {string}
 */
export function composeServiceImage(text, name) {
  let inServices = false;
  let current = "";
  for (const raw of text.split("\n")) {
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (indent === 0) inServices = line === "services:";
    else if (inServices && indent === 2) current = line.replace(/:$/, "");
    else if (inServices && indent === 4 && current === name) {
      const image = /^image:\s*(\S+)$/.exec(line)?.[1];
      if (image !== undefined) return unquote(image);
    }
  }
  throw new Error(`compose.yml: service ${name} has no image`);
}

/**
 * The one-shot `*-init` services, in file order. composeProblems holds each
 * to the one-shot rules (profile init, restart "no", depends_on, no ports,
 * no healthcheck); `pnpm dev:up` runs each with `docker compose run --rm`
 * before waiting for the stack (P2-01b, ADR 0036).
 * @param {string} text compose.yml
 * @returns {string[]}
 */
export function composeOneShots(text) {
  let inServices = false;
  /** @type {string[]} */
  const names = [];
  for (const raw of text.split("\n")) {
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (indent === 0) inServices = line === "services:";
    else if (inServices && indent === 2) {
      const name = line.replace(/:$/, "");
      if (name.endsWith("-init")) names.push(name);
    }
  }
  return names;
}

/**
 * A container image referenced outside compose.yml (e.g. Testcontainers'
 * Ryuk) must be pinned as repo:tag@sha256 and listed in DEPENDENCIES.md
 * section 8, like compose images (ADR 0034, ADR 0035).
 * @param {string} image
 * @param {string} label
 * @param {Set<string>} allowedImages
 * @returns {string[]}
 */
export function pinnedImageProblems(image, label, allowedImages) {
  const pinned = pinnedImage.exec(image);
  if (!pinned) {
    return [
      `${label}: image "${image}" must be pinned as repo:tag@sha256:<64 hex>`,
    ];
  }
  const ref = `${pinned[1] ?? ""}:${pinned[2] ?? ""}`;
  if (pinned[2]?.toLowerCase() === "latest") {
    return [`${label}: image "${image}" must not use the latest tag`];
  }
  if (!allowedImages.has(ref)) {
    return [
      `${label}: image ${ref} is not listed in docs/DEPENDENCIES.md section 8 (ADR 0023)`,
    ];
  }
  return [];
}

export const integrationCommand =
  "vitest run --config vitest.integration.config.mts";

/**
 * @typedef {{
 *   label: string,
 *   scripts: Record<string, string>,
 *   intTests: string[],
 *   config?: string,
 * }} IntegrationPackage
 */

/**
 * Integration tests (P2-02, ADR 0035) run only through `test:integration`
 * = `vitest run --config vitest.integration.config.mts`, a config that
 * calls integrationPreset (which fails on zero test files), and only where
 * `*.int.test.*` files exist: a package cannot have integration tests
 * that never run, or an integration script with nothing to run.
 * @param {IntegrationPackage} pkg
 * @returns {string[]}
 */
export function integrationScriptProblems(pkg) {
  /** @type {string[]} */
  const problems = [];
  const script = pkg.scripts["test:integration"];
  if (script === undefined) {
    if (pkg.intTests.length > 0) {
      problems.push(
        `${pkg.label}: has ${pkg.intTests.join(", ")} but no test:integration script, so they never run`,
      );
    }
    return problems;
  }
  if (script !== integrationCommand) {
    problems.push(
      `${pkg.label}: test:integration must be exactly "${integrationCommand}", found "${script}"`,
    );
  }
  if (pkg.intTests.length === 0) {
    problems.push(`${pkg.label}: test:integration with no *.int.test.* files`);
  }
  if (pkg.config === undefined) {
    problems.push(
      `${pkg.label}: test:integration needs vitest.integration.config.mts`,
    );
  } else if (
    !/from\s+["']@bricx\/vitest-config["']/.test(pkg.config) ||
    !/\bintegrationPreset\s*\(/.test(pkg.config)
  ) {
    problems.push(
      `${pkg.label}: vitest.integration.config.mts must import @bricx/vitest-config and call integrationPreset`,
    );
  }
  return problems;
}

/** A GitHub advisory id: GHSA- then three groups of four. */
const ghsaId = /^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/;
/** Importers whose production closure must not reach an ignored package. */
const runtimeImporter = /^(?:apps|packages)\//;
/** Days before an ignore's "Revisit by" date when the guard starts warning. */
export const auditIgnoreWarningDays = 30;

/**
 * The `auditConfig` block of pnpm-workspace.yaml, read line by line (no YAML
 * dependency). Only `ignoreGhsas`, as a block list of ids, is allowed:
 * never `ignoreCves`, a severity or an audit level (ADR 0037).
 * @param {string} text
 * @returns {{ ignoreGhsas: string[], problems: string[] }}
 */
export function workspaceAuditConfig(text) {
  /** @type {string[]} */
  const ignoreGhsas = [];
  /** @type {string[]} */
  const problems = [];
  let inAudit = false;
  let inList = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trimEnd();
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inAudit = line === "auditConfig:";
      inList = false;
      if (/^audit/i.test(line) && !inAudit) {
        problems.push(
          `pnpm-workspace.yaml: ${line} is not allowed; only auditConfig.ignoreGhsas (ADR 0037)`,
        );
      } else if (line.startsWith("auditConfig:") && !inAudit) {
        problems.push(
          "pnpm-workspace.yaml: auditConfig must be a block mapping (ADR 0037)",
        );
      }
      continue;
    }
    if (!inAudit) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    // Items under a rejected key were reported with the key.
    if (!inList && item !== null) continue;
    if (inList && item?.[1] !== undefined) {
      const id = item[1].replace(/^(["'])(.*)\1$/, "$2");
      if (ghsaId.test(id)) ignoreGhsas.push(id);
      else {
        problems.push(
          `pnpm-workspace.yaml: auditConfig.ignoreGhsas entry "${id}" is not a GHSA id (ADR 0037)`,
        );
      }
      continue;
    }
    const key = /^\s+([A-Za-z]+):\s*(.*)$/.exec(line);
    if (key?.[1] === "ignoreGhsas" && key[2] === "") {
      inList = true;
      continue;
    }
    inList = false;
    problems.push(
      key?.[1] === "ignoreGhsas"
        ? "pnpm-workspace.yaml: list auditConfig.ignoreGhsas one id per line (ADR 0037)"
        : `pnpm-workspace.yaml: auditConfig.${key?.[1] ?? line.trim()} is not allowed; only ignoreGhsas (ADR 0037)`,
    );
  }
  return { ignoreGhsas, problems };
}

/**
 * @typedef {{ file: string, text: string }} AdrFile
 * @typedef {{ id: string, adr: string, package: string, revisitBy: string }} AuditIgnore
 */

/**
 * What the ADRs say about each ignored advisory. An Accepted ADR records an
 * ignore with these lines: `- Advisory: GHSA-…`, `- Package: \`name\`` and
 * `- Revisit by: YYYY-MM-DD`. An amendment that extends the date adds a
 * later `Revisit by` line (or a later ADR); the latest date wins.
 * @param {string} id
 * @param {AdrFile[]} adrs
 * @returns {{ ignore?: AuditIgnore, problems: string[] }}
 */
export function adrForAuditIgnore(id, adrs) {
  // Compared line by line, not with a RegExp built from the id: the id
  // comes from pnpm-workspace.yaml (Semgrep bricx-regexp-non-literal).
  const line = `- Advisory: ${id}`;
  const naming = adrs.filter((adr) =>
    adr.text.split("\n").some((l) => l.trimEnd() === line),
  );
  if (naming.length === 0) {
    return {
      problems: [
        `${id}: ignored in pnpm-workspace.yaml but no ADR records it ("- Advisory: ${id}") (ADR 0037)`,
      ],
    };
  }
  /** @type {string[]} */
  const problems = [];
  /** @type {AuditIgnore | undefined} */
  let ignore;
  // A superseded or proposed ADR may still name the advisory; only
  // Accepted ones count, and at least one must.
  const accepted = naming.filter((adr) =>
    /^- Status: Accepted\b/m.test(adr.text),
  );
  if (accepted.length === 0) {
    return {
      problems: [
        `${id}: no Accepted ADR records it (${naming.map((a) => a.file).join(", ")}) (ADR 0037)`,
      ],
    };
  }
  for (const adr of accepted) {
    const pkg = /^- Package: `([^`\s]+)`\s*$/m.exec(adr.text)?.[1];
    const dates = [
      ...adr.text.matchAll(/^- Revisit by: (\d{4}-\d{2}-\d{2})\s*$/gm),
    ]
      .map((m) => m[1] ?? "")
      .filter((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)));
    if (pkg === undefined) {
      problems.push(
        `${id}: ${adr.file} does not name the package ("- Package: \`name\`") (ADR 0037)`,
      );
    }
    if (dates.length === 0) {
      problems.push(
        `${id}: ${adr.file} has no "- Revisit by: YYYY-MM-DD" date (ADR 0037)`,
      );
    }
    if (pkg === undefined || dates.length === 0) continue;
    const revisitBy = dates.sort().at(-1) ?? "";
    if (ignore === undefined || revisitBy > ignore.revisitBy) {
      ignore = { id, adr: adr.file, package: pkg, revisitBy };
    }
  }
  return ignore === undefined ? { problems } : { ignore, problems };
}

/**
 * @typedef {{
 *   version?: string,
 *   path?: string,
 *   deduped?: boolean,
 *   dependencies?: Record<string, PnpmLsNode>,
 * }} PnpmLsNode
 * @typedef {{
 *   name: string,
 *   path: string,
 *   dependencies?: Record<string, PnpmLsNode>,
 * }} PnpmLsImporter
 */

/**
 * The chains by which apps/ and packages/ importers reach `target` in their
 * production closure, from `pnpm ls -r --prod --depth Infinity --json`.
 * pnpm prints each package's subtree once and marks later occurrences
 * `deduped` with no dependencies, so those are expanded from the full
 * occurrence (by store path); one that is expanded nowhere is reported, not
 * skipped. Workspace links are followed through the linked importer's own
 * production dependencies. tooling/ and the root may reach `target`.
 * @param {PnpmLsImporter[]} importers
 * @param {string} root
 * @param {string} target
 * @returns {string[]}
 */
export function runtimeReachability(importers, root, target) {
  const byPath = new Map(importers.map((i) => [path.resolve(i.path), i]));
  /** @type {Map<string, Record<string, PnpmLsNode>>} */
  const expanded = new Map();
  /** @param {Record<string, PnpmLsNode> | undefined} deps */
  const index = (deps) => {
    for (const node of Object.values(deps ?? {})) {
      if (node.deduped === true || node.path === undefined) continue;
      if (node.dependencies !== undefined && !expanded.has(node.path)) {
        expanded.set(node.path, node.dependencies);
        index(node.dependencies);
      }
    }
  };
  for (const importer of importers) index(importer.dependencies);

  /** @type {string[]} */
  const chains = [];
  for (const importer of importers) {
    const rel = path.relative(root, importer.path).split(path.sep).join("/");
    if (!runtimeImporter.test(`${rel}/`)) continue;
    /** @type {Set<string>} */
    const seen = new Set();
    /**
     * @param {Record<string, PnpmLsNode> | undefined} deps
     * @param {string[]} chain
     */
    const walk = (deps, chain) => {
      for (const [name, node] of Object.entries(deps ?? {})) {
        const here = [...chain, name];
        if (name === target) {
          chains.push(here.join(" > "));
          continue;
        }
        const key = node.path ?? `${name}@${node.version ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (node.version?.startsWith("link:")) {
          walk(byPath.get(path.resolve(node.path ?? ""))?.dependencies, here);
        } else if (node.deduped === true) {
          const full = expanded.get(node.path ?? "");
          if (full === undefined) {
            chains.push(
              `${here.join(" > ")} (deduped by pnpm ls and expanded nowhere, so it cannot be checked)`,
            );
          } else walk(full, here);
        } else walk(node.dependencies, here);
      }
    };
    walk(importer.dependencies, [rel]);
  }
  return chains;
}

/**
 * Every ignored advisory (ADR 0037): a GHSA id recorded in an Accepted ADR
 * that names its package and a "Revisit by" date; the package is not in the
 * production closure of any apps/ or packages/ importer; the date has not
 * passed (a warning in its last 30 days). Ignores live only in
 * pnpm-workspace.yaml, or in package.json's `pnpm.auditConfig` as the
 * fallback, never both; no audit level is ever set.
 * @param {{
 *   workspaceYaml: string,
 *   packageJsonPnpm?: unknown,
 *   npmrc: string,
 *   adrs: AdrFile[],
 *   importers: PnpmLsImporter[],
 *   root: string,
 *   today: string,
 * }} input
 * @returns {{ ignores: AuditIgnore[], problems: string[], warnings: string[] }}
 */
export function auditIgnoreProblems(input) {
  const { ignoreGhsas, problems } = workspaceAuditConfig(input.workspaceYaml);
  /** @type {string[]} */
  const warnings = [];
  /** @type {AuditIgnore[]} */
  const ignores = [];
  const pnpmField =
    /** @type {{ auditConfig?: { ignoreGhsas?: unknown } } | undefined} */ (
      input.packageJsonPnpm
    );
  if (pnpmField?.auditConfig !== undefined) {
    const extra = Object.keys(pnpmField.auditConfig).filter(
      (k) => k !== "ignoreGhsas",
    );
    if (extra.length > 0) {
      problems.push(
        `package.json: pnpm.auditConfig.${extra.join(", ")} is not allowed; only ignoreGhsas (ADR 0037)`,
      );
    }
    const list = pnpmField.auditConfig.ignoreGhsas;
    if (ignoreGhsas.length > 0 && list !== undefined) {
      problems.push(
        "package.json: pnpm.auditConfig and pnpm-workspace.yaml auditConfig both set; keep the ignores in one place (ADR 0037)",
      );
    }
    if (Array.isArray(list)) {
      for (const id of list) {
        if (typeof id === "string" && ghsaId.test(id)) ignoreGhsas.push(id);
        else {
          problems.push(
            `package.json: pnpm.auditConfig.ignoreGhsas entry ${JSON.stringify(id)} is not a GHSA id (ADR 0037)`,
          );
        }
      }
    }
  }
  if (/^\s*audit-level\s*=/m.test(input.npmrc)) {
    problems.push(
      ".npmrc: audit-level is not allowed; the audit reports every severity (ADR 0037)",
    );
  }
  const today = input.today;
  const warnFrom = (/** @type {string} */ date) =>
    new Date(
      Date.parse(`${date}T00:00:00Z`) - auditIgnoreWarningDays * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
  for (const id of new Set(ignoreGhsas)) {
    const found = adrForAuditIgnore(id, input.adrs);
    problems.push(...found.problems);
    if (found.ignore === undefined) continue;
    const ignore = found.ignore;
    ignores.push(ignore);
    for (const chain of runtimeReachability(
      input.importers,
      input.root,
      ignore.package,
    )) {
      problems.push(
        `${id}: ${ignore.package} is reachable from a runtime importer (${chain}); ignores are allowed only for tooling/ and root dependencies (${ignore.adr})`,
      );
    }
    if (today > ignore.revisitBy) {
      problems.push(
        `${id}: the ignore expired on ${ignore.revisitBy} (${ignore.adr}); fix the advisory or extend the date with an ADR amendment`,
      );
    } else if (today >= warnFrom(ignore.revisitBy)) {
      warnings.push(
        `${id}: the ignore expires on ${ignore.revisitBy} (${ignore.adr}); fix the advisory or extend the date with an ADR amendment before then`,
      );
    }
  }
  return { ignores, problems, warnings };
}

/**
 * The `overrides` block of pnpm-workspace.yaml, read line by line (no YAML
 * dependency): one `name: version` per line under a block mapping.
 * @param {string} text
 * @returns {{ overrides: Map<string, string>, problems: string[] }}
 */
export function workspaceOverrides(text) {
  /** @type {Map<string, string>} */
  const overrides = new Map();
  /** @type {string[]} */
  const problems = [];
  let inOverrides = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trimEnd();
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      inOverrides = line === "overrides:";
      if (line.startsWith("overrides:") && !inOverrides) {
        problems.push(
          "pnpm-workspace.yaml: overrides must be a block mapping, one package per line (ADR 0038)",
        );
      }
      continue;
    }
    if (!inOverrides) continue;
    const entry = /^\s+(["']?)([^"':]+)\1:\s*(.*)$/.exec(line);
    const name = entry?.[2] ?? line.trim();
    const version = unquote(entry?.[3] ?? "");
    if (!packageName.test(name)) {
      problems.push(
        `pnpm-workspace.yaml: overrides key "${name}" is not allowed; only plain package names, no selectors or ranges (ADR 0038)`,
      );
      continue;
    }
    if (!exactVersion.test(version)) {
      problems.push(
        `pnpm-workspace.yaml: overrides.${name} "${version}" is not an exact version (ADR 0038)`,
      );
      continue;
    }
    overrides.set(name, version);
  }
  return { overrides, problems };
}

/**
 * Every version of `name` that pnpm-lock.yaml resolves: the `name@version`
 * keys of its `packages:` and `snapshots:` sections.
 * @param {string} lockfile
 * @param {string} name
 * @returns {Set<string>}
 */
export function lockfileVersions(lockfile, name) {
  /** @type {Set<string>} */
  const versions = new Set();
  let inPackages = false;
  for (const line of lockfile.split("\n")) {
    if (/^\S/.test(line)) {
      inPackages = line === "packages:" || line === "snapshots:";
      continue;
    }
    if (!inPackages) continue;
    const key = /^ {2}'?((?:@[^@/\s]+\/)?[^@\s'(]+)@([^('\s:]+)/.exec(line);
    if (key?.[1] === name && key[2] !== undefined) versions.add(key[2]);
  }
  return versions;
}

/**
 * Every pnpm override (ADR 0038): an exact version of a plain package name,
 * set only in pnpm-workspace.yaml (never package.json's `pnpm.overrides` or
 * `resolutions`); recorded in an Accepted ADR with `- Override: \`name\`
 * version` and `- Remove when:` lines; listed in docs/DEPENDENCIES.md; and
 * pnpm-lock.yaml resolves that version of the package and no other. An
 * override whose package is gone from the lockfile is stale and fails too.
 * @param {{
 *   workspaceYaml: string,
 *   manifest: { pnpm?: { overrides?: unknown }, resolutions?: unknown },
 *   adrs: AdrFile[],
 *   dependenciesMd: string,
 *   lockfile: string,
 * }} input
 * @returns {string[]}
 */
export function overrideProblems(input) {
  const { overrides, problems } = workspaceOverrides(input.workspaceYaml);
  if (input.manifest.pnpm?.overrides !== undefined) {
    problems.push(
      "package.json: pnpm.overrides is not allowed; overrides live only in pnpm-workspace.yaml (ADR 0038)",
    );
  }
  if (input.manifest.resolutions !== undefined) {
    problems.push(
      "package.json: resolutions is not allowed; overrides live only in pnpm-workspace.yaml (ADR 0038)",
    );
  }
  const allowed = allowedPackageNames(input.dependenciesMd);
  for (const [name, version] of overrides) {
    const recorded = input.adrs
      .filter((adr) => /^- Status: Accepted\b/m.test(adr.text))
      .flatMap((adr) =>
        [...adr.text.matchAll(/^- Override: `([^`\s]+)` (\S+)\s*$/gm)]
          .filter((m) => m[1] === name)
          .map((m) => ({ adr, version: m[2] ?? "" })),
      );
    if (recorded.length === 0) {
      problems.push(
        `${name}: no Accepted ADR records the override ("- Override: \`${name}\` ${version}") (ADR 0038)`,
      );
    }
    for (const record of recorded) {
      if (record.version !== version) {
        problems.push(
          `${name}: ${record.adr.file} records ${name} ${record.version}, but pnpm-workspace.yaml overrides it to ${version} (ADR 0038)`,
        );
      }
      if (!/^- Remove when: \S/m.test(record.adr.text)) {
        problems.push(
          `${name}: ${record.adr.file} has no "- Remove when:" trigger (ADR 0038)`,
        );
      }
    }
    if (!allowed.has(name)) {
      problems.push(
        `${name} is not listed in docs/DEPENDENCIES.md; an override is a dependency (ADR 0023, ADR 0038)`,
      );
    }
    const versions = lockfileVersions(input.lockfile, name);
    if (versions.size === 0) {
      problems.push(
        `stale override: ${name} is not in pnpm-lock.yaml; remove the override and its ADR line (ADR 0038)`,
      );
    }
    for (const other of [...versions].filter((v) => v !== version).sort()) {
      problems.push(
        `pnpm-lock.yaml still resolves ${name}@${other}; the override pins ${version} (run pnpm install) (ADR 0038)`,
      );
    }
  }
  return problems;
}

// Semgrep (P3-01b, ADR 0043). The checks below take file contents, so the
// fixtures in scripts/guard-fixtures/semgrep/ prove each one.

/** The exact non-comment lines of .semgrepignore (ADR 0043, D5). */
export const semgrepIgnoreLines = [
  "node_modules/",
  ".tools/",
  "scripts/guard-fixtures/",
  "tooling/semgrep/",
];

/** Run lines the CI security job must hold, in this order (ADR 0043). */
export const semgrepCiRuns = [
  "run: node scripts/semgrep.mjs --selftest",
  "run: node scripts/semgrep.mjs --scan",
];

const sha256Hex = /^[0-9a-f]{64}$/;

/**
 * G3: MANIFEST.json lists exactly the rule files, each with its SHA-256, and
 * nothing about an upstream source (the rules are written for this repo).
 * @param {unknown} manifest parsed MANIFEST.json, undefined when missing
 * @param {Record<string, string>} hashes SHA-256 of each file in the rules dir
 * @returns {string[]}
 */
export function semgrepManifestProblems(manifest, hashes) {
  const label = "tooling/semgrep/MANIFEST.json";
  if (manifest === undefined) return [`${label}: missing (G3)`];
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest)
  ) {
    return [`${label}: must be an object (G3)`];
  }
  /** @type {string[]} */
  const problems = [];
  const keys = Object.keys(manifest).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["description", "rules"])) {
    problems.push(
      `${label}: keys must be exactly description and rules, found ${keys.join(", ")} (G3: no upstream source)`,
    );
  }
  const rules = /** @type {Record<string, unknown>} */ (manifest)["rules"];
  if (!Array.isArray(rules))
    return [...problems, `${label}: rules must be a list (G3)`];
  /** @type {Map<string, string>} */
  const listed = new Map();
  for (const entry of /** @type {unknown[]} */ (rules)) {
    const file =
      typeof entry === "object" && entry !== null
        ? /** @type {Record<string, unknown>} */ (entry)["file"]
        : undefined;
    const hash =
      typeof entry === "object" && entry !== null
        ? /** @type {Record<string, unknown>} */ (entry)["sha256"]
        : undefined;
    if (
      typeof file !== "string" ||
      typeof hash !== "string" ||
      !sha256Hex.test(hash)
    ) {
      problems.push(
        `${label}: every rule entry needs a file name and a 64-hex sha256 (G3)`,
      );
      continue;
    }
    if (listed.has(file))
      problems.push(`${label}: ${file} is listed twice (G3)`);
    listed.set(file, hash);
  }
  for (const [file, hash] of listed) {
    const actual = hashes[file];
    if (actual === undefined) {
      problems.push(
        `${label}: lists ${file}, which is not in tooling/semgrep/rules (G3)`,
      );
    } else if (actual !== hash) {
      problems.push(
        `${label}: ${file} has SHA-256 ${actual}, the manifest says ${hash}; a rule change needs a reviewed manifest and DEPENDENCIES.md update (G3)`,
      );
    }
  }
  for (const file of Object.keys(hashes)) {
    if (!listed.has(file)) {
      problems.push(
        `${label}: tooling/semgrep/rules/${file} is not listed in the manifest (G3)`,
      );
    }
  }
  return problems;
}

/**
 * G8: one rule per file, named after its id, with a message, severity ERROR
 * and a CWE or CLAUDE.md rule reference; every rule has a self-test entry
 * and every self-test entry a rule. Line-based, like workflowProblems: the
 * rule files are written in this plain style.
 * @param {Record<string, string>} files rule file name to contents
 * @param {string[]} selftestIds rule ids in tooling/semgrep/selftest/expected.json
 * @returns {string[]}
 */
export function semgrepRuleShapeProblems(files, selftestIds) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const ids = [];
  for (const [name, text] of Object.entries(files)) {
    const label = `tooling/semgrep/rules/${name}`;
    const stem = /^(bricx-[a-z0-9-]+)\.yaml$/.exec(name)?.[1];
    if (stem === undefined) {
      problems.push(`${label}: rule files are named bricx-<id>.yaml (G8)`);
      continue;
    }
    const lines = text.split("\n");
    const idLines = lines.filter((l) => /^\s*- id:/.test(l));
    if (idLines.length !== 1) {
      problems.push(
        `${label}: must hold exactly one rule, found ${String(idLines.length)} (G8)`,
      );
    }
    const id = /^\s*- id:\s*(\S+)\s*$/.exec(idLines[0] ?? "")?.[1];
    if (id !== stem) problems.push(`${label}: rule id must be ${stem} (G8)`);
    ids.push(stem);
    if (!lines.some((l) => /^\s+message:\s*\S/.test(l))) {
      problems.push(`${label}: needs a message (G8)`);
    }
    const severities = lines.filter((l) => /^\s+severity:/.test(l));
    if (
      severities.length === 0 ||
      severities.some((l) => l.trim() !== "severity: ERROR")
    ) {
      problems.push(`${label}: severity must be ERROR (G8)`);
    }
    if (!lines.some((l) => /^\s+(?:cwe|bricx-rule):\s*\S/.test(l))) {
      problems.push(`${label}: metadata needs cwe or bricx-rule (G8)`);
    }
  }
  for (const id of ids) {
    if (!selftestIds.includes(id)) {
      problems.push(
        `tooling/semgrep/selftest/expected.json: no known-bad/known-good entry for ${id} (G8)`,
      );
    }
  }
  for (const id of selftestIds) {
    if (!ids.includes(id)) {
      problems.push(
        `tooling/semgrep/selftest/expected.json: ${id} has no rule file (G8)`,
      );
    }
  }
  return problems;
}

/**
 * @typedef {object} SemgrepState
 * @property {{ image: string, version: string, indexDigest: string, amd64Digest: string }} pin
 * @property {string[]} dockerArgs semgrep-pin.mjs dockerArgs("<target>")
 * @property {string[]} scanArgs
 * @property {string[]} selftestArgs
 * @property {string} runner scripts/semgrep.mjs source
 * @property {string} dependencies docs/DEPENDENCIES.md
 * @property {string | undefined} manifestSha256 SHA-256 of MANIFEST.json
 * @property {string} ci .github/workflows/ci.yml
 * @property {string | undefined} semgrepignore .semgrepignore
 */

/**
 * G1, G2, G4, G5, G6 and G7 (G3 and G8 are separate functions above).
 * @param {SemgrepState} state
 * @returns {string[]}
 */
export function semgrepProblems(state) {
  /** @type {string[]} */
  const problems = [];
  const { pin } = state;

  // G2: exact version, digest-shaped digests, the official image.
  if (pin.image !== "semgrep/semgrep") {
    problems.push(
      `semgrep-pin.mjs: image must be semgrep/semgrep, found ${pin.image} (G2)`,
    );
  }
  if (!/^\d+\.\d+\.\d+$/.test(pin.version)) {
    problems.push(
      `semgrep-pin.mjs: version must be exact (x.y.z), found ${pin.version} (G2)`,
    );
  }
  for (const key of /** @type {const} */ (["indexDigest", "amd64Digest"])) {
    if (!/^sha256:[0-9a-f]{64}$/.test(pin[key])) {
      problems.push(`semgrep-pin.mjs: ${key} must be sha256:<64 hex> (G2)`);
    }
  }

  // G1 and G4: the DEPENDENCIES.md §7 row names the pin and the manifest hash.
  const rows = state.dependencies
    .split("\n")
    .filter((l) => /^\|\s*Semgrep\b/.test(l));
  if (rows.length !== 1) {
    problems.push(
      `docs/DEPENDENCIES.md: needs exactly one Semgrep row in §7, found ${String(rows.length)} (G1)`,
    );
  } else {
    const row = rows[0] ?? "";
    const ref = `${pin.image}:${pin.version}@${pin.indexDigest}`;
    if (!row.includes(`\`${ref}\``)) {
      problems.push(
        `docs/DEPENDENCIES.md: the Semgrep row must name \`${ref}\` (G1)`,
      );
    }
    if (!row.includes(pin.amd64Digest)) {
      problems.push(
        `docs/DEPENDENCIES.md: the Semgrep row must name the amd64 digest ${pin.amd64Digest} (G1)`,
      );
    }
    if (state.manifestSha256 === undefined) {
      problems.push(
        "docs/DEPENDENCIES.md: tooling/semgrep/MANIFEST.json is missing, so the Semgrep row cannot name its SHA-256 (G4)",
      );
    } else if (!row.includes(state.manifestSha256)) {
      problems.push(
        `docs/DEPENDENCIES.md: the Semgrep row must name the MANIFEST.json SHA-256 ${state.manifestSha256} (G4: a rule change needs the matching row)`,
      );
    }
  }

  // G5: the security job runs the self-test, then the scan; nothing else does.
  const ciLines = state.ci.split("\n");
  const start = ciLines.findIndex((l) => l === "  security:");
  let end = ciLines.length;
  for (let i = start + 1; start !== -1 && i < ciLines.length; i += 1) {
    if (/^ {2}\S/.test(ciLines[i] ?? "")) {
      end = i;
      break;
    }
  }
  const job =
    start === -1 ? [] : ciLines.slice(start, end).map((l) => l.trim());
  if (start === -1) problems.push("ci.yml: no security job (G5)");
  const positions = semgrepCiRuns.map((run) =>
    job.indexOf(`- ${run}`) === -1 ? job.indexOf(run) : job.indexOf(`- ${run}`),
  );
  semgrepCiRuns.forEach((run, i) => {
    const count = job.filter((l) => l === run || l === `- ${run}`).length;
    if (count !== 1) {
      problems.push(
        `ci.yml: the security job must hold "${run}" exactly once, found ${String(count)} (G5)`,
      );
    }
    const outside = ciLines.filter(
      (l, n) => (n < start || n >= end) && l.includes(run.slice(5)),
    ).length;
    if (outside > 0)
      problems.push(`ci.yml: "${run}" appears outside the security job (G5)`);
    const here = positions[i] ?? -1;
    const before = positions[i - 1] ?? -1;
    if (i > 0 && here !== -1 && before !== -1 && here < before) {
      problems.push(
        "ci.yml: the Semgrep self-test must run before the scan (G5)",
      );
    }
  });
  if (job.some((l) => /^(?:- )?continue-on-error:/.test(l))) {
    problems.push(
      "ci.yml: continue-on-error is not allowed in the security job (G5)",
    );
  }
  if (job.some((l) => /^(?:- )?if:/.test(l))) {
    problems.push("ci.yml: if: is not allowed in the security job (G5)");
  }

  // G6: no network, read-only mounts, the required flags, our rules only.
  const docker = state.dockerArgs;
  const net = docker.indexOf("--network");
  if (net === -1 || docker[net + 1] !== "none") {
    problems.push("semgrep-pin.mjs: docker run needs --network none (G6)");
  }
  if (!docker.includes("--rm"))
    problems.push("semgrep-pin.mjs: docker run needs --rm (G6)");
  docker.forEach((arg, i) => {
    if (docker[i - 1] === "-v" && !arg.endsWith(":ro")) {
      problems.push(
        `semgrep-pin.mjs: mount ${arg} must be read-only (:ro) (G6)`,
      );
    }
  });
  for (const [name, args] of /** @type {const} */ ([
    ["scanArgs", state.scanArgs],
    ["selftestArgs", state.selftestArgs],
  ])) {
    for (const flag of [
      "--metrics=off",
      "--disable-version-check",
      "--strict",
    ]) {
      if (!args.includes(flag))
        problems.push(`semgrep-pin.mjs: ${name} needs ${flag} (G6)`);
    }
    const configs = args.filter(
      (a) =>
        a === "--config" ||
        a.startsWith("--config=") ||
        a === "-c" ||
        a.startsWith("-f"),
    );
    const at = args.indexOf("--config");
    if (configs.length !== 1 || args[at + 1] !== "/rules") {
      problems.push(
        `semgrep-pin.mjs: ${name} must use exactly one config, --config /rules (G6)`,
      );
    }
    const banned = args.filter((a) =>
      /^(?:auto|p\/|r\/|s\/|https?:)|--metrics=(?:on|auto)|--no-strict|--enable-version-check|--pro|--oss-only=false/.test(
        a,
      ),
    );
    if (banned.length > 0) {
      problems.push(
        `semgrep-pin.mjs: ${name} must not use ${banned.join(" ")} (G6: registry rules or telemetry)`,
      );
    }
  }
  if (!state.scanArgs.includes("--error")) {
    problems.push(
      "semgrep-pin.mjs: scanArgs needs --error so any finding fails (G6)",
    );
  }
  if (
    /--config|SEMGREP_RULES|semgrep\.dev|SEMGREP_APP_TOKEN/.test(state.runner)
  ) {
    problems.push(
      "scripts/semgrep.mjs: the runner must take every flag from semgrep-pin.mjs and name no other rules source (G6)",
    );
  }

  // G7: .semgrepignore holds exactly the approved list.
  if (state.semgrepignore === undefined) {
    problems.push(".semgrepignore: missing (G7)");
  } else {
    const lines = state.semgrepignore
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));
    if (JSON.stringify(lines) !== JSON.stringify(semgrepIgnoreLines)) {
      problems.push(
        `.semgrepignore: entries must be exactly ${JSON.stringify(semgrepIgnoreLines)}, found ${JSON.stringify(lines)} (G7)`,
      );
    }
  }
  return problems;
}

/**
 * The self-test verdict: the known-bad tree yields exactly the expected
 * findings, the known-good tree none.
 * @param {unknown} expected parsed tooling/semgrep/selftest/expected.json
 * @param {string[]} bad findings as "<rule-id> <path>:<line>"
 * @param {string[]} good findings in the known-good tree
 * @returns {string[]}
 */
export function semgrepSelftestProblems(expected, bad, good) {
  const rules =
    typeof expected === "object" && expected !== null
      ? /** @type {Record<string, unknown>} */ (expected)["rules"]
      : undefined;
  if (typeof rules !== "object" || rules === null) {
    return ["expected.json: needs a rules object"];
  }
  /** @type {string[]} */
  const wanted = [];
  for (const [id, entry] of Object.entries(
    /** @type {Record<string, unknown>} */ (rules),
  )) {
    const lines =
      typeof entry === "object" && entry !== null
        ? /** @type {Record<string, unknown>} */ (entry)["bad"]
        : undefined;
    if (!Array.isArray(lines) || lines.length === 0) {
      return [`expected.json: ${id} needs at least one known-bad line`];
    }
    for (const line of /** @type {unknown[]} */ (lines))
      wanted.push(`${id} ${String(line)}`);
  }
  /** @type {string[]} */
  const problems = [];
  for (const w of wanted) {
    if (!bad.includes(w)) problems.push(`not detected: ${w}`);
  }
  for (const b of bad) {
    if (!wanted.includes(b))
      problems.push(`unexpected finding in the known-bad tree: ${b}`);
  }
  for (const g of good) problems.push(`finding in the known-good tree: ${g}`);
  return problems;
}

/**
 * Every Semgrep guard (G1-G8) over one repository state: the real files in
 * check-workspace-scripts.mjs, or a fixture in scripts/guard-fixtures/semgrep.
 * @param {{ state: SemgrepState, manifest: unknown, ruleFiles: Record<string, string>, selftestIds: string[] }} input
 * @returns {string[]}
 */
export function semgrepAllProblems({
  state,
  manifest,
  ruleFiles,
  selftestIds,
}) {
  const hashes = Object.fromEntries(
    Object.entries(ruleFiles).map(([name, text]) => [
      name,
      createHash("sha256").update(text).digest("hex"),
    ]),
  );
  return [
    ...semgrepProblems(state),
    ...semgrepManifestProblems(manifest, hashes),
    ...semgrepRuleShapeProblems(ruleFiles, selftestIds),
  ];
}

// Dependabot cooldown (ADR 0044). Line-based, like the workflow and compose
// guards: .github/dependabot.yml is written in plain block style, and
// anything the rules cannot read is reported rather than skipped.

/** Every Dependabot cooldown value must be at least this many days. */
export const dependabotCooldownDays = 7;

const dependabotDayKeys = new Set([
  "default-days",
  "semver-major-days",
  "semver-minor-days",
  "semver-patch-days",
]);

/** `key:` or `key: value`, the key optionally quoted. */
const yamlKey = /^(["']?)([A-Za-z0-9_-]+)\1:(?:\s+(.*))?$/;
/** Anchors (&a), aliases (*a) and merge keys (<<) outside quotes. */
const yamlAnchor = /(?:^|[\s[{,])[&*][A-Za-z0-9_-]|<<\s*:/;

/** @param {string} line */
const stripComment = (line) => line.replace(/(?:^|\s+)#.*$/, "");

/**
 * Every `updates` entry in .github/dependabot.yml must set `cooldown:` with
 * `default-days` of at least 7 (ADR 0023's 7-day rule; GitHub's default is
 * 3 days), every `semver-*-days` given must be at least 7, and no `include`
 * or `exclude` list may narrow it. Fails closed: a missing file, tabs, flow
 * style, anchors, several documents or an unexpected indent are problems.
 * @param {string | undefined} text the file, undefined when it does not exist
 * @param {string} label
 * @returns {string[]}
 */
export function dependabotProblems(text, label) {
  if (text === undefined) return [`${label}: missing (ADR 0044)`];
  /** @type {string[]} */
  const problems = [];
  const lines = text.split("\n");
  lines.forEach((raw, index) => {
    const where = `${label}:${String(index + 1)}`;
    const line = stripComment(raw).trimEnd();
    if (raw.includes("\t")) problems.push(`${where}: tabs are not allowed`);
    if (/^(?:---|\.\.\.)(?:\s|$)/.test(line)) {
      problems.push(`${where}: one YAML document only`);
    }
    if (yamlAnchor.test(line)) {
      problems.push(
        `${where}: anchors, aliases and merge keys are not allowed`,
      );
    }
  });
  if (problems.length > 0) return problems;

  /** @type {{ ecosystem: string, line: number, cooldowns: number, defaultDays: boolean }[]} */
  const entries = [];
  /** set inside the callback below, so typed wide on purpose */
  let version = /** @type {boolean} */ (false);
  let inUpdates = false;
  /** true after an unknown top-level key: its value is already reported */
  let skipTop = false;
  /** @type {number | undefined} column of the `-` of each updates item */
  let dashIndent;
  /** @type {number | undefined} column of the cooldown children */
  let childIndent;
  let inCooldown = false;
  /** @type {Set<string>} */
  let cooldownKeys = new Set();
  let skipDeeper = false;
  /** @type {(typeof entries)[number] | undefined} */
  let entry;
  const name = () =>
    `updates[${String(entries.length - 1)}] (${entry?.ecosystem ?? "?"})`;

  lines.forEach((raw, index) => {
    const where = `${label}:${String(index + 1)}`;
    const line = stripComment(raw).trimEnd();
    if (line.trim() === "") return;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();

    if (indent === 0) {
      inCooldown = false;
      skipTop = false;
      const key = yamlKey.exec(body);
      if (key?.[2] === "version") {
        version = true;
        if (key[3] !== "2") problems.push(`${where}: version must be 2`);
        return;
      }
      if (key?.[2] === "updates") {
        if (key[3] !== undefined) {
          problems.push(`${where}: updates must be a block list`);
          return;
        }
        inUpdates = true;
        return;
      }
      inUpdates = false;
      skipTop = true;
      problems.push(
        key
          ? `${where}: top-level key ${key[2] ?? ""} is not allowed`
          : `${where}: cannot read this line`,
      );
      return;
    }
    if (!inUpdates) {
      if (skipTop) return;
      problems.push(`${where}: cannot read this line`);
      return;
    }

    if (
      body.startsWith("- ") &&
      (dashIndent === undefined || indent === dashIndent)
    ) {
      dashIndent = indent;
      inCooldown = false;
      const key = yamlKey.exec(body.slice(2).trim());
      if (key?.[2] !== "package-ecosystem" || !key[3]) {
        problems.push(
          `${where}: each updates entry must start with package-ecosystem`,
        );
        entry = {
          ecosystem: "?",
          line: index + 1,
          cooldowns: 0,
          defaultDays: false,
        };
      } else {
        entry = {
          ecosystem: key[3].replace(/^(["'])(.*)\1$/, "$2"),
          line: index + 1,
          cooldowns: 0,
          defaultDays: false,
        };
      }
      entries.push(entry);
      return;
    }
    if (dashIndent === undefined || entry === undefined) {
      problems.push(`${where}: cannot read this line`);
      return;
    }
    const keyIndent = dashIndent + 2;
    if (indent < keyIndent) {
      inCooldown = false;
      problems.push(`${where}: cannot read this line`);
      return;
    }

    if (indent === keyIndent) {
      inCooldown = false;
      const key = yamlKey.exec(body);
      if (!key) {
        problems.push(`${where}: cannot read this line`);
        return;
      }
      if (key[2] !== "cooldown") return;
      entry.cooldowns += 1;
      if (entry.cooldowns > 1) {
        problems.push(`${where}: ${name()} cooldown is set twice`);
      }
      if (key[3] !== undefined) {
        problems.push(`${where}: ${name()} cooldown must be a block mapping`);
        return;
      }
      inCooldown = true;
      childIndent = undefined;
      cooldownKeys = new Set();
      skipDeeper = false;
      return;
    }

    // Deeper than an entry key: the value of that key.
    if (!inCooldown) return;
    childIndent ??= indent;
    if (indent > childIndent) {
      if (!skipDeeper) problems.push(`${where}: cannot read this line`);
      return;
    }
    if (indent < childIndent) {
      problems.push(`${where}: cannot read this line`);
      return;
    }
    skipDeeper = false;
    const key = yamlKey.exec(body);
    if (!key) {
      problems.push(`${where}: cannot read this line`);
      return;
    }
    const field = key[2] ?? "";
    if (cooldownKeys.has(field)) {
      problems.push(`${where}: ${name()} cooldown ${field} is set twice`);
    }
    cooldownKeys.add(field);
    if (field === "include" || field === "exclude") {
      problems.push(
        `${where}: ${name()} cooldown ${field} is not allowed; every dependency waits (ADR 0044)`,
      );
      skipDeeper = true;
      return;
    }
    if (!dependabotDayKeys.has(field)) {
      problems.push(`${where}: ${name()} cooldown key ${field} is not allowed`);
      skipDeeper = true;
      return;
    }
    if (field === "default-days") entry.defaultDays = true;
    const value = key[3] ?? "";
    if (!/^\d+$/.test(value)) {
      problems.push(
        `${where}: ${name()} cooldown ${field} must be a plain integer`,
      );
      return;
    }
    if (Number(value) < dependabotCooldownDays) {
      problems.push(
        `${where}: ${name()} cooldown ${field} must be at least ${String(dependabotCooldownDays)} days (ADR 0044), found ${value}`,
      );
    }
  });

  if (!version) {
    problems.push(`${label}: version must be 2`);
  }
  if (entries.length === 0) {
    problems.push(`${label}: no updates entries`);
  }
  entries.forEach((e, i) => {
    const at = `${label}:${String(e.line)}: updates[${String(i)}] (${e.ecosystem})`;
    if (e.cooldowns === 0) {
      problems.push(
        `${at} has no cooldown; set default-days: ${String(dependabotCooldownDays)} (ADR 0044)`,
      );
    } else if (!e.defaultDays) {
      problems.push(`${at} cooldown has no default-days`);
    }
  });
  return problems;
}

// pnpm i18n:check (P3-03, ADR 0046). The catalog checker only protects main
// while every link of its wiring holds, so each link is checked here and
// each has a fixture in scripts/guard-fixtures/i18n-check/.

/** The exact root and package scripts (ADR 0046, D12). */
export const i18nCheckRootScript = "turbo run i18n:check";
export const i18nCheckPackageScript = "node scripts/i18n-check.mjs";

/**
 * @typedef {{
 *   rootScripts: Record<string, string>,
 *   packageScripts: Record<string, string> | null,
 *   turboTasks: Record<string, unknown>,
 *   ci: string | null,
 * }} I18nCheckWiring
 */

/**
 * The lines of one top-level job in a workflow (two-space indented key),
 * up to the next job; undefined when the job is absent.
 * @param {string} text
 * @param {string} job
 */
function workflowJobLines(text, job) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `  ${job}:`);
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l) || /^\S/.test(l));
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Fails unless the root defines `i18n:check` as turbo run i18n:check, the
 * root `verify` (a turbo run) lists the i18n:check task, packages/i18n
 * defines `i18n:check` as its checker, turbo.json has the task, and CI's
 * verify job runs `pnpm verify` with no continue-on-error.
 * @param {I18nCheckWiring} input
 * @returns {string[]}
 */
export function i18nCheckProblems(input) {
  /** @type {string[]} */
  const problems = [];
  const root = "root package.json";
  const rootScript = input.rootScripts["i18n:check"];
  if (rootScript === undefined) {
    problems.push(`${root}: no "i18n:check" script`);
  } else if (rootScript !== i18nCheckRootScript) {
    problems.push(
      `${root}: "i18n:check" must be exactly "${i18nCheckRootScript}"`,
    );
  }
  const verify = input.rootScripts["verify"] ?? "";
  const verifyTokens = verify.trim().split(/\s+/);
  if (
    verifyTokens[0] !== "turbo" ||
    verifyTokens[1] !== "run" ||
    !verifyTokens.slice(2).includes("i18n:check")
  ) {
    problems.push(
      `${root}: "verify" must run i18n:check as a task of its turbo run`,
    );
  }
  const pkg = "packages/i18n/package.json";
  if (input.packageScripts === null) {
    problems.push(`${pkg}: missing`);
  } else {
    const script = input.packageScripts["i18n:check"];
    if (script === undefined) {
      problems.push(`${pkg}: no "i18n:check" script`);
    } else if (script !== i18nCheckPackageScript) {
      problems.push(
        `${pkg}: "i18n:check" must be exactly "${i18nCheckPackageScript}"`,
      );
    }
  }
  if (!Object.hasOwn(input.turboTasks, "i18n:check")) {
    problems.push(`turbo.json: no "i18n:check" task`);
  }
  const ci = ".github/workflows/ci.yml";
  if (input.ci === null) {
    problems.push(`${ci}: missing`);
  } else {
    const job = workflowJobLines(input.ci, "verify") ?? [];
    if (!job.some((l) => l.trim() === "run: pnpm verify")) {
      problems.push(`${ci}: the verify job must run "pnpm verify"`);
    }
    if (job.some((l) => /^\s*continue-on-error:/.test(l))) {
      problems.push(
        `${ci}: continue-on-error is not allowed in the verify job`,
      );
    }
  }
  return problems;
}

// Migrations (P4-02, ADR 0052). Pure checks over file contents and git
// diff entries, so the fixtures in scripts/guard-fixtures/ prove each one.

/** Where drizzle-kit writes migrations; the migrator reads them here. */
export const migrationsDir = "packages/db/migrations";
const migrationFile = /^\d{4}_[A-Za-z0-9_-]+\.sql$/;

/**
 * SQL text without -- line comments and block comments, so a comment can
 * neither hide a statement nor trip the publication checks.
 * @param {string} sql
 */
function sqlWithoutComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

// A publication name is "quoted" or a plain run up to whitespace or ";".
const publicationRules = [
  {
    pattern: /\bcreate\s+publication\b/i,
    message:
      "CREATE PUBLICATION is not allowed: the bootstrap creates publication powersync once (ADR 0035)",
  },
  {
    pattern: /\bdrop\s+publication\b/i,
    message:
      "DROP PUBLICATION is not allowed: rows written while powersync is missing never replicate (ADR 0035)",
  },
  {
    pattern: /\balter\s+publication\s+(?:"[^"]+"|[^\s;]+)\s+rename\b/i,
    message: "ALTER PUBLICATION ... RENAME is not allowed (ADR 0035)",
  },
  {
    pattern: /\balter\s+publication\s+(?:"[^"]+"|[^\s;]+)\s+owner\s+to\b/i,
    message: "ALTER PUBLICATION ... OWNER TO is not allowed (ADR 0035)",
  },
];

/**
 * The migrations folder: no statement may create, drop, rename or re-own
 * a publication (adding a table to powersync is how a migration publishes
 * one), and the .sql files and the journal must list each other.
 * @param {{ journal: unknown, files: { file: string, text: string }[] }} input
 *   journal: parsed meta/_journal.json; files: the folder's NNNN_*.sql files
 * @returns {string[]}
 */
export function migrationSqlProblems(input) {
  /** @type {string[]} */
  const problems = [];
  const label = `${migrationsDir}/meta/_journal.json`;
  /** @type {string[]} */
  const tags = [];
  const journal = input.journal;
  if (
    typeof journal !== "object" ||
    journal === null ||
    !("entries" in journal) ||
    !Array.isArray(journal.entries)
  ) {
    problems.push(`${label}: missing or has no entries array`);
  } else {
    for (const entry of /** @type {unknown[]} */ (journal.entries)) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        "tag" in entry &&
        typeof entry.tag === "string"
      ) {
        tags.push(entry.tag);
      } else {
        problems.push(`${label}: an entry has no tag`);
      }
    }
  }
  const files = new Set(input.files.map((f) => f.file));
  for (const tag of tags) {
    if (!files.has(`${tag}.sql`)) {
      problems.push(`${label}: ${tag} has no ${tag}.sql`);
    }
  }
  for (const { file, text } of input.files) {
    if (!migrationFile.test(file)) {
      problems.push(`${migrationsDir}/${file}: not an NNNN_tag.sql name`);
    }
    if (!tags.includes(file.replace(/\.sql$/, ""))) {
      problems.push(
        `${migrationsDir}/${file}: not listed in meta/_journal.json`,
      );
    }
    const sql = sqlWithoutComments(text);
    for (const rule of publicationRules) {
      if (rule.pattern.test(sql)) {
        problems.push(`${migrationsDir}/${file}: ${rule.message}`);
      }
    }
  }
  return problems;
}

/**
 * @typedef {{ status: string, path: string, to?: string }} DiffEntry
 *   one `git diff --name-status -M` line: A, M, D, T, Rnnn or Cnnn; `to`
 *   is the new path of a rename or copy
 */

/**
 * Merged migrations are immutable (change 4 of the approved P4-02 plan):
 * on a PR, fails on any edit, delete or rename of an NNNN_*.sql the base
 * already has, and on any _journal.json change other than entries appended
 * after the base's. New files and appended entries pass.
 * @param {{ changes: DiffEntry[], base: unknown, head: unknown }} input
 *   changes: diff from the merge base to HEAD; base, head: the parsed
 *   journal on each side (null when the file does not exist there)
 * @returns {string[]}
 */
export function migrationImmutabilityProblems(input) {
  /** @type {string[]} */
  const problems = [];
  const journalPath = `${migrationsDir}/meta/_journal.json`;
  const isMerged = (/** @type {string} */ p) =>
    p.startsWith(`${migrationsDir}/`) &&
    migrationFile.test(p.slice(migrationsDir.length + 1));
  for (const change of input.changes) {
    const kind = change.status.charAt(0);
    if (isMerged(change.path)) {
      if (kind === "M" || kind === "T") {
        problems.push(`${change.path}: edits a merged migration`);
      } else if (kind === "D") {
        problems.push(`${change.path}: deletes a merged migration`);
      } else if (kind === "R") {
        problems.push(
          `${change.path}: renames a merged migration (to ${change.to ?? "?"})`,
        );
      }
    }
    if (change.path === journalPath && (kind === "D" || kind === "R")) {
      problems.push(`${journalPath}: deleted or renamed`);
    }
  }
  if (input.base !== null && input.head !== null) {
    const base = input.base;
    const head = input.head;
    const entriesOf = (/** @type {unknown} */ j) =>
      typeof j === "object" &&
      j !== null &&
      "entries" in j &&
      Array.isArray(j.entries)
        ? /** @type {unknown[]} */ (j.entries)
        : undefined;
    const baseEntries = entriesOf(base);
    const headEntries = entriesOf(head);
    const rest = (/** @type {unknown} */ j) =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(typeof j === "object" && j !== null ? j : {})
            .filter(([key]) => key !== "entries")
            .sort(([a], [b]) => a.localeCompare(b)),
        ),
      );
    if (baseEntries === undefined || headEntries === undefined) {
      problems.push(`${journalPath}: has no entries array`);
    } else {
      const kept = headEntries.slice(0, baseEntries.length);
      if (
        headEntries.length < baseEntries.length ||
        JSON.stringify(kept) !== JSON.stringify(baseEntries)
      ) {
        problems.push(
          `${journalPath}: changes merged entries (only appending is allowed)`,
        );
      }
      if (rest(base) !== rest(head)) {
        problems.push(
          `${journalPath}: changes fields other than entries (only appending is allowed)`,
        );
      }
    }
  }
  return problems;
}

/** Run lines the CI security job must hold, in this order (ADR 0052). */
export const migrationsImmutableCiRuns = [
  "run: node scripts/migrations-immutable.mjs --selftest",
  "run: node scripts/migrations-immutable.mjs --check",
];

/**
 * The CI security job checks out full history and runs the immutability
 * self-test, then the check, with no continue-on-error.
 * @param {string | null} ci .github/workflows/ci.yml, null when missing
 * @returns {string[]}
 */
export function migrationsCiProblems(ci) {
  const label = ".github/workflows/ci.yml";
  if (ci === null) return [`${label}: missing`];
  const job = workflowJobLines(ci, "security");
  if (job === undefined) return [`${label}: no security job`];
  /** @type {string[]} */
  const problems = [];
  if (!job.some((l) => l.trim() === "fetch-depth: 0")) {
    problems.push(
      `${label}: the security job must check out with fetch-depth: 0 (migrations-immutable diffs against the base branch)`,
    );
  }
  const runs = job.map((l) => l.trim());
  const at = migrationsImmutableCiRuns.map((r) => runs.indexOf(r));
  if (at.some((i) => i === -1) || (at[0] ?? 0) > (at[1] ?? 0)) {
    problems.push(
      `${label}: the security job must run "${migrationsImmutableCiRuns.join('" then "')}"`,
    );
  }
  if (job.some((l) => /^\s*continue-on-error:/.test(l))) {
    problems.push(
      `${label}: continue-on-error is not allowed in the security job`,
    );
  }
  return problems;
}
