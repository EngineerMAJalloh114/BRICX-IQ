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
  /** @type {{ name: string, image: boolean, healthcheck: boolean }[]} */
  const services = [];
  /** @type {{ name: string, image: boolean, healthcheck: boolean } | undefined} */
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
      service = { name, image: false, healthcheck: false };
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
    if (!s.healthcheck) {
      problems.push(`${label}: service ${s.name} has no healthcheck`);
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
  const naming = adrs.filter((adr) =>
    new RegExp(`^- Advisory: ${id}\\s*$`, "m").test(adr.text),
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
