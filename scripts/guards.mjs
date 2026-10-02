// Pure checks used by check-workspace-scripts.mjs (P1-06, ADR 0031). Each
// takes file contents and returns a list of problems, so the fixtures in
// scripts/guard-fixtures/ can prove every rule fails when broken.

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
 * service, comments included (P2-02, ADR 0035).
 * @param {string} text
 * @param {string} label
 * @param {Set<string>} allowedImages repo:tag pairs from DEPENDENCIES.md
 * @returns {{ problems: string[], services: number }}
 */
export function composeProblems(text, label, allowedImages) {
  /** @type {string[]} */
  const problems = [];
  /**
   * @typedef {{ name: string, image: boolean, healthcheck: boolean,
   *   profiles: string[] | undefined, restart: string | undefined,
   *   dependsOn: boolean, ports: boolean }} ComposeService
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
    }
  });
  for (const s of services) {
    if (!s.image) problems.push(`${label}: service ${s.name} has no image`);
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
  return { problems, services: services.length };
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
  schemas: ["bricx", "extensions"],
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
