// `pnpm new-module <module> <Entity> <subject>` (P4-09, ADR 0059): copies
// the module template (apps/api/src/modules/_template and its tests) into
// a new API module, e.g. `pnpm new-module milestones Milestone
// project.milestone`. Deterministic, no prompts:
//
// 1. Refuses, before writing anything: a dirty working tree; a module name
//    outside ^[a-z][a-z0-9-]*$ (one path segment), ending in or repeating a
//    hyphen, reserved or already used (module folder, test folder, schema
//    file or table); an Entity that is not PascalCase or equals the
//    module's PascalCase name; a subject that is not in @bricx/permissions'
//    catalogue, is append-only (owner decision 2026-10-17: the template has
//    no append-only shape) or is not project-level with created_by and
//    create/read actions (the template's shape); a derived Postgres name
//    over 63 bytes.
// 2. Copies the template, renaming its identifiers, dropping the
//    `new-module:template-only` blocks and enabling the
//    `new-module:copy-only:` lines; the table moves to
//    packages/db/src/schema/<module>.ts.
// 3. Inserts one line before each marker comment (never a regex over
//    code): tables.ts, TENANT_TABLES, OUTBOX_TOPICS and their tests, and
//    AppModule's imports.
// 4. Runs drizzle-kit generate, appends `pnpm db:rls`'s SQL to the new
//    migration, formats what it wrote, runs `pnpm gen:api`.
// 5. Prints "review the generated migration (rule 12)". It never says the
//    migration is reviewed: a person does that (CLAUDE.md rule 12).
//
// Any failure after writing restores the tree (it was clean). A second run
// with the same name refuses and changes nothing. `--selftest` proves all
// of this in a temporary git worktree (CI job new-module).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const USAGE = "usage: pnpm new-module <module> <Entity> <subject>";
export const RULE_12 = "review the generated migration (rule 12)";

/** The template's own names; every one is renamed in a copy. */
export const TEMPLATE = Object.freeze({
  module: "template-items",
  entity: "TemplateItem",
  subject: "project.milestone",
  srcDir: "apps/api/src/modules/_template",
  testDir: "apps/api/test/modules/_template",
  schemaFile: "template-items.schema.ts",
});

/** Module names nobody may take (folders, layers, the template's own). */
export const RESERVED = Object.freeze([
  "template",
  "template-items",
  "common",
  "modules",
  "auth",
  "db",
  "health",
  "openapi",
  "public-api",
  "app",
  "api",
  "v1",
]);

const MODULE_NAME = /^[a-z][a-z0-9-]*$/;
const ENTITY_NAME = /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)*$/;
const MAX_ENTITY = 60;
const MAX_IDENTIFIER_BYTES = 63;

/** The marker comments, each a whole line in its file. */
export const MARKERS = Object.freeze({
  tables: {
    file: "packages/db/src/schema/tables.ts",
    marker:
      "// new-module: tables (pnpm new-module adds an export above, P4-09)",
  },
  tenantTables: {
    file: "packages/db/src/rls.ts",
    marker:
      "// new-module: TENANT_TABLES (pnpm new-module adds a line above, P4-09)",
  },
  tenantTablesTest: {
    file: "packages/db/test/rls.test.ts",
    marker:
      "// new-module: TENANT_TABLES (pnpm new-module adds a line above, P4-09)",
  },
  topics: {
    file: "packages/db/src/outbox.ts",
    marker:
      "// new-module: OUTBOX_TOPICS (pnpm new-module adds an entry above, P4-09)",
  },
  topicsTest: {
    file: "packages/db/test/outbox.test.ts",
    marker:
      "// new-module: OUTBOX_TOPICS (pnpm new-module adds an entry above, P4-09)",
  },
  appImports: {
    file: "apps/api/src/app.module.ts",
    marker:
      "// new-module: imports (pnpm new-module adds an import above, P4-09)",
  },
  appModules: {
    file: "apps/api/src/app.module.ts",
    marker:
      "// new-module: modules (pnpm new-module adds a module above, P4-09)",
  },
});

/**
 * @typedef {{ level: string, createdBy: boolean, appendOnly: boolean, actions: string[] }} SubjectInfo
 * @typedef {{ modules: string[], files: string[], tables: string[], subjects: Map<string, SubjectInfo>, roleKeys: string[] }} NewModuleState
 *   modules: folders under apps/api/src/modules and apps/api/test/modules;
 *   files: schema files under packages/db/src/schema (names without .ts);
 *   tables: bricx tables declared anywhere in packages/db/src or the
 *   template (schema.table); roleKeys: every catalogue key in the
 *   default role bundles
 */

/**
 * The names a module and an entity give.
 * @param {string} module kebab-case, e.g. cost-codes
 * @param {string} entity PascalCase, e.g. CostCode
 */
export function namesOf(module, entity) {
  const parts = module.split("-");
  const pascal = parts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
  const snake = parts.join("_");
  return {
    module,
    snake,
    pascal,
    camel: pascal.charAt(0).toLowerCase() + pascal.slice(1),
    upper: snake.toUpperCase(),
    entity,
    entityCamel: entity.charAt(0).toLowerCase() + entity.slice(1),
    table: `bricx.${snake}`,
    topic: `${snake}.created`,
  };
}

/**
 * Postgres names the copy creates (policies, indexes, constraints, the
 * outbox topic, which its CHECK bounds the same way).
 * @param {string} snake
 */
function derivedNames(snake) {
  return [
    snake,
    `${snake}_pkey`,
    `${snake}_select`,
    `${snake}_insert`,
    `${snake}_update`,
    `${snake}_name`,
    `${snake}_project`,
    `${snake}_name_length`,
    `${snake}_version`,
    `${snake}.created`,
  ];
}

/**
 * Every reason `args` cannot become a module in a tree in `state`; [] when
 * it can.
 * @param {readonly string[]} args
 * @param {NewModuleState} state
 * @returns {string[]}
 */
export function newModuleProblems(args, state) {
  if (args.length !== 3) return [USAGE];
  const [module = "", entity = "", subject = ""] = args;
  /** @type {string[]} */
  const problems = [];
  if (!MODULE_NAME.test(module)) {
    problems.push(
      "module must match ^[a-z][a-z0-9-]*$ (one path segment, no separators)",
    );
  } else if (module.endsWith("-") || module.includes("--")) {
    problems.push("module must not end with a hyphen or repeat one");
  } else if (RESERVED.includes(module)) {
    problems.push(`module "${module}" is reserved`);
  } else if (module.includes("template")) {
    problems.push('module must not contain "template"');
  } else {
    const names = namesOf(module, entity);
    if (state.modules.includes(module)) {
      problems.push(`module "${module}" already exists`);
    } else if (state.files.includes(module)) {
      problems.push(`packages/db/src/schema/${module}.ts already exists`);
    } else if (state.tables.includes(names.table)) {
      problems.push(`table ${names.table} already exists`);
    }
    const long = derivedNames(names.snake).find(
      (n) => Buffer.byteLength(n) > MAX_IDENTIFIER_BYTES,
    );
    if (long !== undefined) {
      problems.push(`derived name ${long} is longer than 63 bytes`);
    }
  }
  if (entity.length > MAX_ENTITY || !ENTITY_NAME.test(entity)) {
    problems.push(
      `Entity must be PascalCase (^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)*$, at most ${String(MAX_ENTITY)} characters)`,
    );
  } else if (entity.includes("Template")) {
    problems.push('Entity must not contain "Template"');
  } else if (
    MODULE_NAME.test(module) &&
    namesOf(module, entity).pascal === entity
  ) {
    problems.push(
      "Entity must differ from the module's PascalCase name (e.g. milestones / Milestone)",
    );
  }
  const info = state.subjects.get(subject);
  if (info === undefined) {
    problems.push("unknown subject: not in @bricx/permissions' catalogue");
  } else if (info.appendOnly) {
    problems.push(
      `${subject} is append-only: new-module refuses append-only subjects (the template has update-capable grants; ADR 0059)`,
    );
  } else if (info.level !== "project") {
    problems.push(
      `the template is project-level (org_id, project_id): ${subject} is ${info.level}-level`,
    );
  } else if (!info.createdBy) {
    problems.push(`${subject} has no created_by: the template's rows carry it`);
  } else if (
    !info.actions.includes("create") ||
    !info.actions.includes("read")
  ) {
    problems.push(
      `${subject} has no create action or no read action: the template needs both`,
    );
  } else if (!state.roleKeys.includes(`${subject}.create.project`)) {
    problems.push(
      `no role bundle grants ${subject}.create.project: the module's tests act as that role`,
    );
  }
  return problems;
}

/**
 * `text` with `line` (re-indented to the marker's indentation) inserted
 * before the one line that is exactly `marker` (trimmed). Refuses a
 * missing or repeated marker and a line already present.
 * @param {string} text
 * @param {string} marker
 * @param {string} line
 * @returns {{ text: string } | { problem: string }}
 */
export function insertBeforeMarker(text, marker, line) {
  const lines = text.split("\n");
  const at = lines.flatMap((l, i) => (l.trim() === marker ? [i] : []));
  if (at.length === 0) return { problem: `marker "${marker}" not found` };
  if (at.length > 1) {
    return {
      problem: `marker "${marker}" appears ${String(at.length)} times`,
    };
  }
  if (lines.some((l) => l.trim() === line.trim())) {
    return { problem: `the file already holds ${line.trim()}` };
  }
  const index = at[0] ?? 0;
  const indent = /^\s*/.exec(lines[index] ?? "")?.[0] ?? "";
  lines.splice(index, 0, `${indent}${line.trim()}`);
  return { text: lines.join("\n") };
}

/**
 * A template file's text as the copy's: template-only blocks dropped,
 * copy-only lines enabled, the template's names renamed.
 * @param {string} text
 * @param {ReturnType<typeof namesOf>} names
 * @param {string} subject
 */
export function copyText(text, names, subject) {
  /** @type {string[]} */
  const out = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "// new-module:template-only:start") {
      if (skipping) throw new Error("nested template-only block");
      skipping = true;
      continue;
    }
    if (trimmed === "// new-module:template-only:end") {
      if (!skipping) throw new Error("template-only end without start");
      skipping = false;
      continue;
    }
    if (skipping) continue;
    const copyOnly = /^(\s*)\/\/ new-module:copy-only: (.*)$/.exec(line);
    out.push(
      copyOnly === null ? line : `${copyOnly[1] ?? ""}${copyOnly[2] ?? ""}`,
    );
  }
  if (skipping) throw new Error("template-only block without end");
  /** @type {[string, string][]} */
  const renames = [
    ["TemplateItems", names.pascal],
    ["templateItems", names.camel],
    ["template_items", names.snake],
    ["template-items", names.module],
    ["TEMPLATE_ITEMS", names.upper],
    ["TemplateItem", names.entity],
    ["templateItem", names.entityCamel],
    ["modules/_template", `modules/${names.module}`],
    [TEMPLATE.subject, subject],
  ];
  // One pass, longest name first at each position, with no RegExp built
  // from data (Semgrep bricx-regexp-non-literal): a replacement is never
  // renamed again.
  const froms = renames.toSorted(([a], [b]) => b.length - a.length);
  const joined = out.join("\n");
  let renamed = "";
  let at = 0;
  while (at < joined.length) {
    const hit = froms.find(([from]) => joined.startsWith(from, at));
    if (hit === undefined) {
      renamed += joined[at] ?? "";
      at += 1;
    } else {
      renamed += hit[1];
      at += hit[0].length;
    }
  }
  if (/template/i.test(renamed)) {
    throw new Error("a template name survived the copy");
  }
  return renamed;
}

/**
 * A module's export, by name, from a source file (Node strips the types).
 * @param {string} file
 * @param {string} name
 * @returns {Promise<object>}
 */
async function exportOf(file, name) {
  /** @type {unknown} */
  const mod = await import(pathToFileURL(file).href);
  /** @type {unknown} */
  const value =
    typeof mod === "object" && mod !== null && name in mod
      ? Reflect.get(mod, name)
      : undefined;
  if (typeof value !== "object" || value === null) {
    throw new Error(`new-module: cannot read ${name} from ${file}`);
  }
  return value;
}

/**
 * Every catalogue key in the default role bundles.
 * @param {string} root
 */
async function readRoleKeys(root) {
  const roles = await exportOf(
    path.join(root, "packages/permissions/src/roles.ts"),
    "ROLES",
  );
  return Object.values(roles).flatMap((keys) =>
    Array.isArray(keys) ? keys.filter((k) => typeof k === "string") : [],
  );
}

/**
 * The catalogue subjects, read from @bricx/permissions' source.
 * @param {string} root
 * @returns {Promise<Map<string, SubjectInfo>>}
 */
async function readSubjects(root) {
  const resources = await exportOf(
    path.join(root, "packages/permissions/src/catalogue.ts"),
    "RESOURCES",
  );
  /** @type {Map<string, SubjectInfo>} */
  const subjects = new Map();
  for (const [name, value] of Object.entries(resources)) {
    /** @type {unknown} */
    const def = value;
    if (typeof def !== "object" || def === null) continue;
    const level = "level" in def ? def.level : undefined;
    const createdBy = "createdBy" in def ? def.createdBy : undefined;
    const appendOnly = "appendOnly" in def ? def.appendOnly : undefined;
    const actions = "actions" in def ? def.actions : undefined;
    if (
      typeof level !== "string" ||
      typeof createdBy !== "boolean" ||
      typeof appendOnly !== "boolean" ||
      typeof actions !== "object" ||
      actions === null
    ) {
      throw new Error(`new-module: unreadable catalogue entry ${name}`);
    }
    subjects.set(name, {
      level,
      createdBy,
      appendOnly,
      actions: Object.keys(actions),
    });
  }
  return subjects;
}

/**
 * What a run checks against: existing modules, schema files, tables and
 * the catalogue.
 * @param {string} root
 * @returns {Promise<NewModuleState>}
 */
export async function readNewModuleState(root) {
  /** @param {string} dir */
  const dirs = async (dir) =>
    existsSync(path.join(root, dir))
      ? (await readdir(path.join(root, dir), { withFileTypes: true }))
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
      : [];
  const modules = [
    ...new Set([
      ...(await dirs("apps/api/src/modules")),
      ...(await dirs("apps/api/test/modules")),
    ]),
  ];
  const schemaDir = path.join(root, "packages/db/src/schema");
  const schemaFiles = (await readdir(schemaDir)).filter((f) =>
    f.endsWith(".ts"),
  );
  /** @type {Set<string>} */
  const tables = new Set();
  const sources = [
    ...schemaFiles.map((f) => path.join(schemaDir, f)),
    path.join(root, "packages/db/src/rls.ts"),
    path.join(root, TEMPLATE.srcDir, TEMPLATE.schemaFile),
  ];
  for (const file of sources) {
    if (!existsSync(file)) continue;
    const text = await readFile(file, "utf8");
    for (const m of text.matchAll(/\.table\(\s*"([a-z0-9_]+)"/g)) {
      tables.add(`bricx.${m[1] ?? ""}`);
    }
    for (const m of text.matchAll(/"bricx\.([a-z0-9_]+)"/g)) {
      tables.add(`bricx.${m[1] ?? ""}`);
    }
  }
  return {
    modules,
    files: schemaFiles.map((f) => f.slice(0, -".ts".length)),
    tables: [...tables],
    subjects: await readSubjects(root),
    roleKeys: await readRoleKeys(root),
  };
}

/**
 * Runs `command` in `cwd`, inheriting output; throws on a non-zero exit.
 * @param {string} cwd
 * @param {string} command
 * @param {string[]} args
 */
function run(cwd, command, args) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${String(result.status)}`,
    );
  }
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" });

/**
 * Restores a tree that was clean before the run: tracked files back to
 * HEAD, files the run created removed.
 * @param {string} root
 */
async function restore(root) {
  const status = git(root, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "-z",
  ])
    .split("\0")
    .filter((l) => l !== "");
  for (const entry of status) {
    const file = entry.slice(3);
    if (entry.startsWith("??"))
      await rm(path.join(root, file), { force: true });
  }
  git(root, ["checkout", "--", "."]);
  for (const dir of [
    path.join(root, "apps/api/src/modules"),
    path.join(root, "apps/api/test/modules"),
  ]) {
    for (const d of await readdir(dir)) {
      const full = path.join(dir, d);
      if ((await readdir(full).catch(() => ["x"])).length === 0) {
        await rm(full, { recursive: true });
      }
    }
  }
}

/**
 * Makes the module. Returns the migration file's path (repo-relative).
 * @param {string} root
 * @param {string} module
 * @param {string} entity
 * @param {string} subject
 */
async function createModule(root, module, entity, subject) {
  const names = namesOf(module, entity);
  /** @type {string[]} */
  const written = [];
  /**
   * @param {string} rel
   * @param {string} text
   */
  const write = async (rel, text) => {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
    written.push(rel);
  };
  // 2. The copy.
  /** @type {[string, string][]} */
  const copies = [
    [TEMPLATE.srcDir, `apps/api/src/modules/${module}`],
    [TEMPLATE.testDir, `apps/api/test/modules/${module}`],
  ];
  for (const [from, to] of copies) {
    for (const file of (await readdir(path.join(root, from))).sort()) {
      const text = copyText(
        await readFile(path.join(root, from, file), "utf8"),
        names,
        subject,
      );
      const target =
        file === TEMPLATE.schemaFile
          ? `packages/db/src/schema/${module}.ts`
          : `${to}/${file.replace(TEMPLATE.module, module)}`;
      await write(target, text);
    }
  }
  // 3. One line before each marker.
  const inserts = /** @type {[keyof typeof MARKERS, string][]} */ ([
    ["tables", `export * from "./${module}.js";`],
    ["tenantTables", `"${names.table}": "${subject}",`],
    ["tenantTablesTest", `"${names.table}": "${subject}",`],
    [
      "topics",
      `"${names.topic}": topic({ queue: "${names.snake}", keys: ["id", "projectId"], maxBytes: 128 }),`,
    ],
    [
      "topicsTest",
      `"${names.topic}": { queue: "${names.snake}", keys: ["id", "projectId"], maxBytes: 128 },`,
    ],
    [
      "appImports",
      `import { ${names.pascal}Module } from "./modules/${module}/public-api.js";`,
    ],
    ["appModules", `${names.pascal}Module,`],
  ]);
  for (const [key, line] of inserts) {
    const { file, marker } = MARKERS[key];
    const result = insertBeforeMarker(
      await readFile(path.join(root, file), "utf8"),
      marker,
      line,
    );
    if ("problem" in result) throw new Error(`${file}: ${result.problem}`);
    await write(file, result.text);
  }
  // 4. The migration: drizzle-kit, then pnpm db:rls's SQL appended.
  const migrations = path.join(root, "packages/db/migrations");
  const before = new Set(await readdir(migrations));
  run(root, "pnpm", [
    "--filter",
    "@bricx/db",
    "generate",
    "--name",
    names.snake,
  ]);
  const created = (await readdir(migrations)).filter(
    (f) => !before.has(f) && f.endsWith(".sql"),
  );
  if (created.length !== 1 || created[0] === undefined) {
    throw new Error(
      `drizzle-kit wrote ${String(created.length)} migrations, expected 1`,
    );
  }
  const migration = `packages/db/migrations/${created[0]}`;
  const rls = execFileSync(
    process.execPath,
    ["packages/db/scripts/rls.ts", names.table, subject],
    { cwd: root, encoding: "utf8" },
  );
  const sqlText = await readFile(path.join(root, migration), "utf8");
  await writeFile(
    path.join(root, migration),
    `${sqlText.trimEnd()}\n--> statement-breakpoint\n${rls.trimEnd()}\n`,
  );
  // Formats everything the run wrote that Prettier owns.
  const changed = git(root, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "-z",
  ])
    .split("\0")
    .filter((l) => l !== "")
    .map((l) => l.slice(3))
    .filter((f) => /\.(?:ts|json)$/.test(f));
  run(root, "pnpm", ["exec", "prettier", "--write", ...changed]);
  run(root, "pnpm", ["gen:api"]);
  return migration;
}

/**
 * The CLI. Exit 0: made; 1: refused or failed (the tree is unchanged);
 * 2: usage.
 * @param {string[]} argv
 * @param {string} root
 */
async function main(argv, root) {
  if (argv[0] === "--selftest") {
    const rev = argv
      .find((a) => a.startsWith("--rev="))
      ?.slice("--rev=".length);
    return selftest(root, argv.includes("--keep"), rev ?? "HEAD");
  }
  if (argv.length !== 3) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const [module = "", entity = "", subject = ""] = argv;
  if (
    git(root, ["status", "--porcelain", "--untracked-files=all"]).trim() !== ""
  ) {
    process.stderr.write(
      "new-module: the working tree is not clean: commit or stash first, so a failed run can be undone\n",
    );
    return 1;
  }
  const problems = newModuleProblems(argv, await readNewModuleState(root));
  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`new-module: ${p}\n`);
    return 1;
  }
  let migration;
  try {
    migration = await createModule(root, module, entity, subject);
  } catch (error) {
    await restore(root);
    process.stderr.write(
      `new-module: failed, the tree is restored: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  const names = namesOf(module, entity);
  process.stdout.write(
    [
      `new-module: made module ${module} (${entity}, subject ${subject}, table ${names.table}).`,
      `Next: ${RULE_12}: ${migration}`,
      "It holds drizzle-kit's CREATE TABLE and pnpm db:rls's policies. Read every statement before you commit it.",
      "Then run pnpm verify and pnpm test:integration.",
      "",
    ].join("\n"),
  );
  return 0;
}

/**
 * Proves new-module end to end in a temporary git worktree of HEAD:
 * offline install; a copy (milestones / Milestone / project.milestone)
 * that passes pnpm verify, pnpm gen:api with no diff and the db and api
 * integration suites; a second run and a dirty tree refused with nothing
 * changed. Prints each step's time.
 * @param {string} root
 * @param {boolean} keep leave the worktree for inspection
 * @param {string} rev the commit to test (CI: HEAD)
 */
async function selftest(root, keep, rev) {
  const work = await mkdtemp(path.join(os.tmpdir(), "bricx-new-module-"));
  const started = performance.now();
  /**
   * @param {string} label
   * @param {() => void | Promise<void>} step
   */
  const step = async (label, step) => {
    const t = performance.now();
    process.stdout.write(`\n== selftest: ${label}\n`);
    await step();
    process.stdout.write(
      `== selftest: ${label}: ok in ${((performance.now() - t) / 1000).toFixed(1)} s\n`,
    );
  };
  const node = process.execPath;
  const script = path.join(work, "scripts/new-module.mjs");
  /** @param {string[]} args */
  const attempt = (args) =>
    spawnSync(node, [script, ...args], {
      cwd: work,
      encoding: "utf8",
      env: process.env,
    });
  const status = () =>
    git(work, ["status", "--porcelain", "--untracked-files=all"]);
  /**
   * @param {boolean} ok
   * @param {string} what
   */
  const expect = (ok, what) => {
    if (!ok) throw new Error(`selftest: ${what}`);
  };
  try {
    await step(`worktree of ${rev}`, () => {
      git(root, ["worktree", "add", "--detach", work, rev]);
    });
    await step("pnpm install --offline --frozen-lockfile", () => {
      run(work, "pnpm", ["install", "--offline", "--frozen-lockfile"]);
    });
    await step("refuses invalid input, changing nothing", () => {
      for (const args of [
        ["Milestones", "Milestone", "project.milestone"],
        ["ledger-lines", "LedgerLine", "finance.ledger"],
        ["../x", "Milestone", "project.milestone"],
      ]) {
        const r = attempt(args);
        expect(r.status === 1, `${args.join(" ")} was not refused`);
      }
      expect(status() === "", "a refused run changed the tree");
    });
    await step("pnpm new-module milestones Milestone project.milestone", () => {
      const r = attempt(["milestones", "Milestone", "project.milestone"]);
      process.stdout.write(r.stdout);
      process.stderr.write(r.stderr);
      expect(r.status === 0, `new-module exited ${String(r.status)}`);
      expect(r.stdout.includes(RULE_12), "the rule 12 line was not printed");
      expect(!/\breviewed\b/i.test(r.stdout), "it claimed a review");
      git(work, ["add", "-A"]);
      git(work, [
        "-c",
        "user.name=new-module selftest",
        "-c",
        "user.email=selftest@invalid",
        "commit",
        "--no-verify",
        "-q",
        "-m",
        "feat(api): selftest copy",
      ]);
    });
    await step("a second run refuses and changes nothing", () => {
      const head = git(work, ["rev-parse", "HEAD"]);
      const r = attempt(["milestones", "Milestone", "project.milestone"]);
      expect(r.status === 1, "the second run was not refused");
      expect(r.stderr.includes('module "milestones" already exists'), r.stderr);
      expect(
        status() === "" && git(work, ["rev-parse", "HEAD"]) === head,
        "the second run changed the tree",
      );
    });
    await step("a dirty tree is refused", async () => {
      await writeFile(path.join(work, "dirty.txt"), "x\n");
      const r = attempt(["punch-items", "PunchItem", "project.milestone"]);
      expect(
        r.status === 1 && r.stderr.includes("not clean"),
        "a dirty tree was not refused",
      );
      await rm(path.join(work, "dirty.txt"));
      expect(status() === "", "the dirty-tree run changed the tree");
    });
    await step("pnpm verify", () => {
      run(work, "pnpm", ["verify"]);
    });
    await step("pnpm gen:api, then no diff", () => {
      run(work, "pnpm", ["gen:api"]);
      expect(status() === "", `gen:api changed the tree:\n${status()}`);
    });
    await step("db and api integration suites", () => {
      run(work, "pnpm", [
        "--filter",
        "@bricx/db",
        "--filter",
        "@bricx/api",
        "test:integration",
      ]);
    });
  } finally {
    if (!keep) {
      spawnSync("git", ["worktree", "remove", "--force", work], { cwd: root });
      await rm(work, { recursive: true, force: true });
    }
  }
  process.stdout.write(
    `\nnew-module selftest passed in ${((performance.now() - started) / 1000).toFixed(1)} s${keep ? ` (worktree kept at ${work})` : ""}\n`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = path.resolve(import.meta.dirname, "..");
  process.exitCode = await main(process.argv.slice(2), root);
}
