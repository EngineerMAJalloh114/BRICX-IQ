// The catalogue as data (ROADMAP P3-05 step 1, Done when: "snapshot test of
// the catalogue"). The committed generated/catalogue.json is the snapshot:
// generate.test.ts fails when it is stale; this file pins the closed lists
// and the rules every entry follows.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  CATALOGUE,
  PERMISSIONS,
  RESOURCES,
  SUBJECT_TYPES,
  allowedScopes,
  isPermissionName,
  parseCatalogueKey,
} from "../src/catalogue.ts";
import { SCOPES } from "../src/scopes.ts";

const committed = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, "../generated/catalogue.json"),
    "utf8",
  ),
) as { permissions: string[]; resources: Record<string, unknown> };

describe("closed lists", () => {
  it("scopes are exactly own, site, project, org", () => {
    expect([...SCOPES]).toEqual(["own", "site", "project", "org"]);
  });

  // The P3-05 plan said "28 resources" but listed 27; the list is what was
  // approved (deviation noted for architect review in ADR 0048). P5-03
  // adds org.session (ADR 0063), so the count is 28 again; P5-06 adds
  // org.access_grant (ADR 0067): 29.
  it("29 resources, exactly the approved list", () => {
    expect([...SUBJECT_TYPES]).toEqual([
      "org.organization",
      "org.member",
      "org.role",
      "org.audit",
      "org.session",
      "org.access_grant",
      "project.project",
      "project.site",
      "project.member",
      "project.task",
      "project.milestone",
      "field.dailylog",
      "field.photo",
      "field.attendance",
      "field.drawing",
      "supply.material",
      "supply.material_request",
      "supply.purchase_order",
      "supply.goods_receipt",
      "supply.inventory",
      "finance.budget",
      "finance.expenditure",
      "finance.payment",
      "finance.reconciliation",
      "finance.change_order",
      "finance.fx_rate",
      "finance.ledger",
      "document.file",
      "report.dashboard",
    ]);
    expect(SUBJECT_TYPES).toHaveLength(29);
  });

  it("every resource has exactly the approved actions", () => {
    const actions = Object.fromEntries(
      SUBJECT_TYPES.map((s) => [s, Object.keys(RESOURCES[s].actions)]),
    );
    expect(actions).toEqual({
      "org.organization": ["read", "update"],
      "org.member": ["read", "invite", "update", "remove"],
      "org.role": ["read", "manage"],
      "org.audit": ["read", "export"],
      "org.session": ["read", "revoke"],
      "org.access_grant": ["read", "grant", "revoke"],
      "project.project": ["create", "read", "update", "archive"],
      "project.site": ["create", "read", "update", "archive"],
      "project.member": ["read", "assign"],
      "project.task": ["create", "read", "update", "complete"],
      "project.milestone": ["create", "read", "update", "verify"],
      "field.dailylog": ["create", "read", "update", "approve"],
      "field.photo": ["create", "read"],
      "field.attendance": ["create", "read", "approve"],
      "field.drawing": ["upload", "read", "markup"],
      "supply.material": ["create", "read", "update"],
      "supply.material_request": ["create", "read", "update", "approve"],
      "supply.purchase_order": ["create", "read", "approve"],
      "supply.goods_receipt": ["create", "read"],
      "supply.inventory": ["read", "issue", "adjust"],
      "finance.budget": ["create", "read", "update", "approve"],
      "finance.expenditure": ["create", "read", "approve"],
      "finance.payment": ["request", "read", "approve", "record"],
      "finance.reconciliation": ["create", "read"],
      "finance.change_order": ["create", "read", "approve", "sign_off"],
      "finance.fx_rate": ["read", "update"],
      "finance.ledger": ["read", "export"],
      "document.file": ["upload", "read", "share"],
      "report.dashboard": ["read", "export"],
    });
  });

  it("the action list is the union of the resources' actions, with no wildcard", () => {
    const used = new Set(
      SUBJECT_TYPES.flatMap((s) => Object.keys(RESOURCES[s].actions)),
    );
    expect([...ACTIONS].sort()).toEqual([...used].sort());
    expect(ACTIONS).not.toContain("all");
    expect(SUBJECT_TYPES).not.toContain("all");
    for (const key of CATALOGUE) expect(key).not.toMatch(/\*|\ball\b/);
  });
});

describe("catalogue entries resource.action.scope", () => {
  it("every entry parses back to an allowed scope of a known permission", () => {
    for (const key of CATALOGUE) {
      const parsed = parseCatalogueKey(key);
      expect(parsed, key).toBeDefined();
      if (parsed === undefined) continue;
      expect(isPermissionName(parsed.permission)).toBe(true);
      expect(allowedScopes(parsed.permission)).toContain(parsed.scope);
    }
  });

  it("matches the ROADMAP's examples", () => {
    expect(CATALOGUE).toContain("finance.payment.approve.project");
    expect(CATALOGUE).toContain("field.dailylog.create.site");
    expect(CATALOGUE).toContain("org.role.manage.org");
  });

  it("is sorted, unique and one entry per permission and allowed scope", () => {
    expect([...CATALOGUE]).toEqual([...new Set(CATALOGUE)].sort());
    const expected = PERMISSIONS.flatMap((p) =>
      allowedScopes(p).map((s) => `${p}.${s}`),
    ).sort();
    expect([...CATALOGUE]).toEqual(expected);
  });

  it("the committed snapshot lists the same entries", () => {
    expect(committed.permissions).toEqual([...CATALOGUE]);
    expect(Object.keys(committed.resources)).toEqual([...SUBJECT_TYPES]);
  });

  it("parseCatalogueKey rejects anything outside the catalogue", () => {
    for (const bad of [
      "finance.payment.approve.own",
      "finance.payment.approve",
      "finance.payment.manage.org",
      "all.manage.org",
      "FINANCE.payment.approve.org",
      "finance.payment.approve.org.extra",
      "",
      "x".repeat(65),
    ]) {
      expect(parseCatalogueKey(bad), bad).toBeUndefined();
    }
  });
});

describe("scope rules (approved plan, ruling 4e)", () => {
  it("org-level resources allow org scope only", () => {
    for (const s of SUBJECT_TYPES.filter((t) => RESOURCES[t].level === "org")) {
      for (const scopes of Object.values(RESOURCES[s].actions)) {
        expect(scopes, s).toEqual(["org"]);
      }
    }
  });

  it("approve is never own scope", () => {
    for (const p of PERMISSIONS.filter((x) => x.endsWith(".approve"))) {
      expect(allowedScopes(p), p).not.toContain("own");
    }
  });

  it("project.project.create is org scope only", () => {
    expect(allowedScopes("project.project.create")).toEqual(["org"]);
  });

  it("finance.payment is org or project only; fx_rate org only", () => {
    for (const a of ["request", "read", "approve", "record"] as const) {
      expect(allowedScopes(`finance.payment.${a}`)).toEqual(["org", "project"]);
    }
    expect(allowedScopes("finance.fx_rate.update")).toEqual(["org"]);
  });

  it("site scope only on resources whose rows carry a site, own only where rows carry created_by", () => {
    for (const s of SUBJECT_TYPES) {
      const r = RESOURCES[s];
      for (const scopes of Object.values(r.actions)) {
        if ((scopes as readonly string[]).includes("site")) {
          expect(r.level, s).toBe("site");
        }
        if ((scopes as readonly string[]).includes("own")) {
          expect(r.createdBy, s).toBe(true);
        }
        if ((scopes as readonly string[]).includes("project")) {
          expect(r.level, s).not.toBe("org");
        }
      }
    }
  });

  it("synced resources are exactly the approved list (no finance data, ruling 3)", () => {
    expect(SUBJECT_TYPES.filter((s) => RESOURCES[s].synced)).toEqual([
      "project.project",
      "project.site",
      "project.task",
      "project.milestone",
      "field.dailylog",
      "field.photo",
      "field.attendance",
      "field.drawing",
      "supply.material",
      "supply.material_request",
      "supply.goods_receipt",
      "supply.inventory",
      "document.file",
    ]);
  });

  it("org.session is org-level, not synced, not append-only, and carries no created_by (P5-03, ADR 0063)", () => {
    expect(RESOURCES["org.session"]).toEqual({
      level: "org",
      createdBy: false,
      synced: false,
      appendOnly: false,
      actions: { read: ["org"], revoke: ["org"] },
    });
    expect(CATALOGUE).toContain("org.session.read.org");
    expect(CATALOGUE).toContain("org.session.revoke.org");
    expect(CATALOGUE).not.toContain("org.session.read.own");
    expect(CATALOGUE).not.toContain("org.session.revoke.project");
  });

  // P5-06 (ADR 0067): a temporary elevation is one catalogue key granted to
  // one user for a bounded time; granting and revoking are org-level
  // administrator actions, so the resource is org-level and org-scoped
  // only, never synced (no stream until P8-02) and not append-only (a
  // revocation updates the row). A user reads their own grants through an
  // own-row RLS policy with no grant, as org.session.
  it("org.access_grant is org-level, org scope only, not synced, not append-only, no created_by (P5-06, ADR 0067)", () => {
    const resources: Partial<
      Record<string, (typeof RESOURCES)[keyof typeof RESOURCES]>
    > = RESOURCES;
    expect(resources["org.access_grant"]).toEqual({
      level: "org",
      createdBy: false,
      synced: false,
      appendOnly: false,
      actions: { read: ["org"], grant: ["org"], revoke: ["org"] },
    });
    const keys: readonly string[] = CATALOGUE;
    expect(keys).toContain("org.access_grant.read.org");
    expect(keys).toContain("org.access_grant.grant.org");
    expect(keys).toContain("org.access_grant.revoke.org");
    expect(keys).not.toContain("org.access_grant.read.own");
    expect(keys).not.toContain("org.access_grant.grant.project");
    expect(keys).not.toContain("org.access_grant.revoke.project");
    expect(keys.filter((k) => k.startsWith("org.access_grant."))).toHaveLength(
      3,
    );
  });

  it("append-only resources are the audit log and the ledger", () => {
    expect(SUBJECT_TYPES.filter((s) => RESOURCES[s].appendOnly)).toEqual([
      "org.audit",
      "finance.ledger",
    ]);
  });
});
