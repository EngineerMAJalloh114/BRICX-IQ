// Generated layers (ROADMAP P3-05 step 5; architect rulings 2 and 3; design
// constraint 5). The committed files under generated/ must equal what the
// generators produce now (the drift check runs in `pnpm verify`), a stale
// copy fails the check, and a change to one permission changes every layer
// that encodes it.
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkGenerated } from "../scripts/gen-lib.mjs";
import {
  DEFAULT_MODEL,
  GENERATED_FILES,
  generateAll,
  syncStreams,
  validateModel,
} from "../src/generate.ts";
import type { Model } from "../src/generate.ts";
import { RESOURCES, SUBJECT_TYPES, resourceOf } from "../src/catalogue.ts";

const generatedDir = path.join(import.meta.dirname, "../generated");
const committed = (file: string) =>
  readFileSync(path.join(generatedDir, file), "utf8");
const tmp = mkdtempSync(path.join(tmpdir(), "bricx-permissions-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A deep, mutable copy of the default model. */
const copyModel = (): Model => structuredClone<Model>(DEFAULT_MODEL);

describe("the committed outputs are current", () => {
  it("lists exactly the six generated files", () => {
    expect([...GENERATED_FILES]).toEqual([
      "catalogue.json",
      "roles.json",
      "sod.json",
      "rls.sql",
      "sync-streams.yaml",
      "role-matrix.md",
    ]);
  });

  it.each(GENERATED_FILES)(
    "%s equals the generator's output byte for byte",
    (file) => {
      expect(committed(file)).toBe(generateAll()[file]);
    },
  );

  it("the default model has no problems", () => {
    expect(validateModel(DEFAULT_MODEL)).toEqual([]);
  });

  it("checkGenerated passes on the committed directory", async () => {
    expect(await checkGenerated(generatedDir)).toEqual([]);
  });

  it.each(GENERATED_FILES)("a stale %s fails the check", async (file) => {
    const dir = path.join(tmp, `stale-${file}`);
    cpSync(generatedDir, dir, { recursive: true });
    writeFileSync(path.join(dir, file), `${committed(file)}\n`);
    expect(await checkGenerated(dir)).toEqual([`stale:${file}`]);
  });

  it("a missing file fails the check", async () => {
    const dir = path.join(tmp, "missing");
    cpSync(generatedDir, dir, { recursive: true });
    rmSync(path.join(dir, "rls.sql"));
    expect(await checkGenerated(dir)).toEqual(["missing:rls.sql"]);
  });
});

/** Subjects whose part of a layer differs between two outputs. */
function changedSubjects(before: Model, after: Model) {
  const a = generateAll(before);
  const b = generateAll(after);
  const rolesA = JSON.parse(a["roles.json"]) as Record<
    string,
    { rules: { subject: string }[] }
  >;
  const rolesB = JSON.parse(b["roles.json"]) as Record<
    string,
    { rules: { subject: string }[] }
  >;
  const casl = new Set<string>();
  for (const role of new Set([
    ...Object.keys(rolesA),
    ...Object.keys(rolesB),
  ])) {
    const ra = (rolesA[role]?.rules ?? []).map((r) => JSON.stringify(r));
    const rb = (rolesB[role]?.rules ?? []).map((r) => JSON.stringify(r));
    for (const r of [
      ...ra.filter((x) => !rb.includes(x)),
      ...rb.filter((x) => !ra.includes(x)),
    ]) {
      casl.add((JSON.parse(r) as { subject: string }).subject);
    }
  }
  const sections = (text: string) =>
    new Map(
      text
        .split(/\n(?=-- resource )/)
        .filter((s) => s.startsWith("-- resource "))
        .map((s) => [s.slice(12, s.indexOf(" ", 12)), s] as const),
    );
  const rls = new Set<string>();
  const ra = sections(a["rls.sql"]);
  const rb = sections(b["rls.sql"]);
  for (const k of new Set([...ra.keys(), ...rb.keys()])) {
    if (ra.get(k) !== rb.get(k)) rls.add(k);
  }
  const sync = new Set<string>();
  const sa = new Map(
    syncStreams(before).map((s) => [s.resource, JSON.stringify(s)]),
  );
  const sb = new Map(
    syncStreams(after).map((s) => [s.resource, JSON.stringify(s)]),
  );
  for (const k of new Set([...sa.keys(), ...sb.keys()])) {
    if (sa.get(k) !== sb.get(k)) sync.add(k);
  }
  return {
    casl: [...casl],
    rls: [...rls],
    sync: [...sync],
    files: GENERATED_FILES.filter((f) => a[f] !== b[f]),
  };
}

describe("drift: a change to one permission reaches every layer that encodes it", () => {
  it("dropping 'own' from field.photo.read changes CASL and sync for field.photo only; RLS is unchanged by design (ruling 2)", () => {
    const after = copyModel();
    const photo = after.resources["field.photo"];
    if (photo === undefined) throw new Error("fixture");
    photo.actions.read = ["org", "project", "site"];
    after.roles.subcontractor = (after.roles.subcontractor ?? []).map((k) =>
      k === "field.photo.read.own" ? "field.photo.read.site" : k,
    );
    expect(validateModel(after)).toEqual([]);
    const changed = changedSubjects(DEFAULT_MODEL, after);
    expect(changed.casl).toEqual(["field.photo"]);
    expect(changed.sync).toEqual(["field.photo"]);
    expect(changed.rls).toEqual([]);
    expect(changed.files).toEqual([
      "catalogue.json",
      "roles.json",
      "sync-streams.yaml",
      "role-matrix.md",
    ]);
  });

  it("making field.photo append-only changes RLS for field.photo only", () => {
    const after = copyModel();
    const photo = after.resources["field.photo"];
    if (photo === undefined) throw new Error("fixture");
    photo.appendOnly = true;
    const changed = changedSubjects(DEFAULT_MODEL, after);
    expect(changed.rls).toEqual(["field.photo"]);
    expect(changed.casl).toEqual([]);
    expect(changed.sync).toEqual([]);
  });

  it("removing field.photo changes CASL, RLS and sync, for field.photo only", () => {
    const after = copyModel();
    delete after.resources["field.photo"];
    for (const role of Object.keys(after.roles)) {
      after.roles[role] = (after.roles[role] ?? []).filter(
        (k) => !k.startsWith("field.photo."),
      );
    }
    expect(validateModel(after)).toEqual([]);
    const changed = changedSubjects(DEFAULT_MODEL, after);
    expect(changed.casl).toEqual(["field.photo"]);
    expect(changed.rls).toEqual(["field.photo"]);
    expect(changed.sync).toEqual(["field.photo"]);
    expect(changed.files).toEqual(
      [...GENERATED_FILES].filter((f) => f !== "sod.json"),
    );
  });

  it("an invalid model is reported, not generated", () => {
    const after = copyModel();
    after.roles.foreman = [
      ...(after.roles.foreman ?? []),
      "finance.payment.approve.own",
    ];
    expect(validateModel(after)).toEqual([
      "role_entry_not_in_catalogue:foreman",
    ]);
    expect(() => generateAll(after)).toThrow(
      expect.objectContaining({ code: "invalid_model" }),
    );
    const own = copyModel();
    const dashboard = own.resources["report.dashboard"];
    if (dashboard === undefined) throw new Error("fixture");
    dashboard.actions.read = ["org", "own"];
    expect(validateModel(own)).toContain(
      "own_without_created_by:report.dashboard",
    );
    const unpaired = copyModel();
    unpaired.sodRules = unpaired.sodRules.filter(
      (r) => r.second !== "finance.budget.approve",
    );
    expect(validateModel(unpaired)).toEqual([
      "approve_without_sod_pair:finance.budget",
    ]);
  });
});

describe("rls.sql (ruling 2): tenant and project isolation only", () => {
  const sql = committed("rls.sql");

  it("states in its header that per-permission, site and own checks are CASL and SoD", () => {
    const header = sql.slice(0, sql.indexOf("-- resource "));
    expect(header).toContain("tenant and project isolation only");
    expect(header).toContain("CASL");
    expect(header).toContain("SoD");
    expect(header).toContain("No table names");
  });

  it("uses the ROADMAP primitives and current_setting('app.user_id', true), never has_grant", () => {
    expect(sql).toContain("app.current_org()");
    expect(sql).toContain("app.has_project(");
    expect(sql).toContain("current_setting('app.user_id', true)");
    expect(sql).not.toMatch(/has_grant|has_permission/);
    expect(sql).not.toMatch(
      /CREATE\s+POLICY|ALTER\s+TABLE|CREATE\s+TABLE|DROP\s/i,
    );
  });

  it("one section per resource; SELECT and INSERT always; UPDATE unless append-only; never DELETE", () => {
    for (const s of SUBJECT_TYPES) {
      const start = sql.indexOf(`-- resource ${s} `);
      expect(start, s).toBeGreaterThan(-1);
      const end = sql.indexOf("-- resource ", start + 1);
      const section = sql.slice(start, end === -1 ? undefined : end);
      expect(section).toContain("-- SELECT USING");
      expect(section).toContain("-- INSERT WITH CHECK");
      expect(section.includes("-- UPDATE"), s).toBe(!RESOURCES[s].appendOnly);
      expect(section).not.toContain("DELETE USING");
      expect(section).toContain("app.current_org()");
      expect(section.includes("app.has_project("), s).toBe(
        RESOURCES[s].level !== "org",
      );
    }
  });
});

describe("sync-streams.yaml (ruling 3): permission-filtered stream parameters", () => {
  const streams = syncStreams(DEFAULT_MODEL);
  const yaml = committed("sync-streams.yaml");

  it("one stream per synced resource, never a finance resource", () => {
    expect(streams.map((s) => s.resource)).toEqual(
      SUBJECT_TYPES.filter((s) => RESOURCES[s].synced),
    );
    for (const s of streams)
      expect(s.resource.startsWith("finance.")).toBe(false);
  });

  it("each stream names its read permission, allowed scopes and filter columns", () => {
    const photo = streams.find((s) => s.resource === "field.photo");
    expect(photo).toEqual(
      expect.objectContaining({
        resource: "field.photo",
        readPermission: "field.photo.read",
        scopes: ["own", "site", "project", "org"],
        columns: {
          org: "org_id",
          project: "project_id",
          site: "site_id",
          own: "created_by",
        },
      }),
    );
    const material = streams.find((s) => s.resource === "supply.material");
    expect(material?.columns).toEqual({ org: "org_id" });
  });

  it("every grant clause is pinned to the resource's read permission and one allowed scope", () => {
    for (const s of streams) {
      const clauses =
        s.query.match(/permission = '[^']+' AND scope = '[a-z]+'/g) ?? [];
      expect(clauses, s.resource).toEqual(
        s.scopes.map(
          (scope) =>
            `permission = '${s.readPermission}' AND scope = '${scope}'`,
        ),
      );
      expect(s.query).toContain("auth.parameter('org_id')");
      expect(s.query.includes("<<user_project_access>>"), s.resource).toBe(
        resourceOf(s.resource)?.level !== "org",
      );
    }
  });

  it("a user without resource.read at a project receives none of its rows", () => {
    // Evaluates each stream's structured parameters, the same data the query
    // text is rendered from, against grants rows.
    type GrantRow = { permission: string; scope: string; target: string };
    const visible = (
      resource: string,
      grants: readonly GrantRow[],
      row: { org: string; project: string; site: string; createdBy: string },
      user: string,
      projects: readonly string[],
    ) => {
      const s = streams.find((x) => x.resource === resource);
      if (s === undefined) return false;
      if (row.org !== "org-a") return false;
      if (
        resourceOf(s.resource)?.level !== "org" &&
        !projects.includes(row.project)
      )
        return false;
      return grants.some(
        (g) =>
          g.permission === s.readPermission &&
          (s.scopes as readonly string[]).includes(g.scope) &&
          ((g.scope === "org" && g.target === row.org) ||
            (g.scope === "project" && g.target === row.project) ||
            (g.scope === "site" && g.target === row.site) ||
            (g.scope === "own" &&
              g.target === row.org &&
              row.createdBy === user)),
      );
    };
    const row = { org: "org-a", project: "p1", site: "s1", createdBy: "u2" };
    // Member of p1 with create but not read: nothing.
    expect(
      visible(
        "field.photo",
        [{ permission: "field.photo.create", scope: "project", target: "p1" }],
        row,
        "u1",
        ["p1"],
      ),
    ).toBe(false);
    // Read at p2 only: nothing from p1.
    expect(
      visible(
        "field.photo",
        [{ permission: "field.photo.read", scope: "project", target: "p2" }],
        row,
        "u1",
        ["p1", "p2"],
      ),
    ).toBe(false);
    // Read at p1: visible.
    expect(
      visible(
        "field.photo",
        [{ permission: "field.photo.read", scope: "project", target: "p1" }],
        row,
        "u1",
        ["p1"],
      ),
    ).toBe(true);
    // Read of another resource: nothing.
    expect(
      visible(
        "field.photo",
        [{ permission: "field.dailylog.read", scope: "project", target: "p1" }],
        row,
        "u1",
        ["p1"],
      ),
    ).toBe(false);
    // Own read sees own rows only.
    expect(
      visible(
        "field.photo",
        [{ permission: "field.photo.read", scope: "own", target: "org-a" }],
        row,
        "u1",
        ["p1"],
      ),
    ).toBe(false);
    expect(
      visible(
        "field.photo",
        [{ permission: "field.photo.read", scope: "own", target: "org-a" }],
        row,
        "u2",
        ["p1"],
      ),
    ).toBe(true);
    // Project scope not allowed for project.project? It is; but a scope a
    // stream does not list never matches.
    expect(
      visible(
        "supply.material",
        [
          {
            permission: "supply.material.read",
            scope: "project",
            target: "p1",
          },
        ],
        row,
        "u1",
        ["p1"],
      ),
    ).toBe(false);
  });

  it("marks the view and table names as placeholders for P8-02", () => {
    const header = yaml.slice(0, yaml.indexOf("streams:"));
    expect(header).toContain("<<user_project_access>>");
    expect(header).toContain("<<user_grants>>");
    expect(header).toContain("placeholder");
    expect(header).toContain("P8-02");
    expect(yaml).toContain("<<table:field.photo>>");
  });
});
