// P6-06b (ADR 0084; owner condition C3; Done-when 13, 14, 15): external
// members. EXTERNAL_ORG_KEYS is the allowlist of org-scope keys an
// external member's org role keeps; everything else at org scope is
// denied, with a reason per resource. Three proofs:
// - subset: for every system role, what an external member keeps of the
//   bundle is a subset of the bundle, against a list written out here;
// - no org-scope finance key, by role or by elevation;
// - completeness: every resource with an org-scope key is allowed in
//   full or denied with a reason, so a new resource fails this test until
//   someone decides.
// The API's buildAccess applies the same functions
// (apps/api/test/grants-source.test.ts proves the built grants).
import { describe, expect, it } from "vitest";
import {
  CATALOGUE,
  parseCatalogueKey,
  resourceOf,
  splitPermission,
} from "../src/catalogue.ts";
import {
  EXTERNAL_ORG_DENIED,
  EXTERNAL_ORG_KEYS,
  externalAllowsElevation,
  externalKeepsOrgKey,
  externalOrgKeys,
  orgScopeSubjects,
} from "../src/external.ts";
import { ROLE_IDS, ROLES } from "../src/roles.ts";

/** The allowlist, written out (C3): a change here is a review. */
const EXPECTED_ALLOWED = ["org.region_config.read.org"];

const subjectOf = (key: string): string => {
  const parsed = parseCatalogueKey(key);
  if (parsed === undefined) throw new Error("not a catalogue key");
  const parts = splitPermission(parsed.permission);
  if (parts === undefined) throw new Error("not a permission");
  return parts.subject;
};
const orgKeys = CATALOGUE.filter((key) => key.endsWith(".org"));

describe("EXTERNAL_ORG_KEYS: the allowlist (C3)", () => {
  it("is exactly the reviewed list, frozen, of org-scope catalogue keys", () => {
    expect([...EXTERNAL_ORG_KEYS]).toEqual(EXPECTED_ALLOWED);
    expect(Object.isFrozen(EXTERNAL_ORG_KEYS)).toBe(true);
    expect(Object.isFrozen(EXTERNAL_ORG_DENIED)).toBe(true);
    for (const key of EXTERNAL_ORG_KEYS) {
      expect(CATALOGUE).toContain(key);
      expect(parseCatalogueKey(key)?.scope).toBe("org");
    }
  });

  it("holds no finance key (Done-when 14)", () => {
    expect(EXTERNAL_ORG_KEYS.filter((k) => k.startsWith("finance."))).toEqual(
      [],
    );
    for (const key of orgKeys.filter((k) => k.startsWith("finance."))) {
      expect(externalKeepsOrgKey(key)).toBe(false);
    }
  });

  it("holds no key on a project- or site-level resource, so an external member never reaches every project of the org", () => {
    for (const key of EXTERNAL_ORG_KEYS) {
      const parsed = parseCatalogueKey(key);
      const parts =
        parsed === undefined ? undefined : splitPermission(parsed.permission);
      expect(parts).toBeDefined();
      if (parts === undefined) continue;
      expect(resourceOf(parts.subject)?.level).toBe("org");
    }
  });

  it("holds read actions only", () => {
    for (const key of EXTERNAL_ORG_KEYS) {
      expect(key.split(".")[2]).toBe("read");
    }
  });
});

describe("completeness (Done-when 15): every resource with an org-scope key is decided", () => {
  it("each is allowed in full or denied with a reason; a partly allowed one is in both lists", () => {
    const subjects = orgScopeSubjects();
    expect(subjects.length).toBeGreaterThan(20);
    for (const subject of subjects) {
      const keys = orgKeys.filter((key) => subjectOf(key) === subject);
      expect(keys.length).toBeGreaterThan(0);
      const allowed = keys.filter((key) => externalKeepsOrgKey(key));
      const reason = EXTERNAL_ORG_DENIED[subject];
      if (allowed.length < keys.length) {
        expect(reason, subject).toBeTypeOf("string");
        expect((reason ?? "").trim().length, subject).toBeGreaterThan(10);
      }
    }
  });

  it("orgScopeSubjects() is the catalogue's, computed independently here", () => {
    expect(orgScopeSubjects()).toEqual(
      [...new Set(orgKeys.map(subjectOf))].sort(),
    );
  });

  it("the denied list names only resources that have an org-scope key, and no resource that is allowed in full", () => {
    const subjects = new Set(orgScopeSubjects());
    for (const subject of Object.keys(EXTERNAL_ORG_DENIED)) {
      expect(subjects.has(subject), subject).toBe(true);
      const keys = orgKeys.filter((key) => subjectOf(key) === subject);
      expect(
        keys.some((key) => !externalKeepsOrgKey(key)),
        subject,
      ).toBe(true);
    }
  });

  it("every finance resource is denied (C3)", () => {
    const finance = orgScopeSubjects().filter((s) => s.startsWith("finance."));
    expect(finance.length).toBeGreaterThan(0);
    for (const subject of finance) {
      expect(EXTERNAL_ORG_DENIED[subject], subject).toBeTypeOf("string");
    }
  });
});

describe("externalOrgKeys(bundle): a subset, for all 13 system roles (Done-when 13)", () => {
  it("there are 13 system roles", () => {
    expect(ROLE_IDS.length).toBe(13);
  });

  it.each(ROLE_IDS.map((role) => [role] as const))(
    "%s: what an external member keeps is a subset of the bundle, exactly the allowlisted keys in it, and no finance key",
    (role) => {
      const bundle = ROLES[role];
      const kept = externalOrgKeys(bundle);
      for (const key of kept) expect(bundle).toContain(key);
      // The oracle: the written-out list, not EXTERNAL_ORG_KEYS.
      expect([...kept].sort()).toEqual(
        bundle.filter((key) => EXPECTED_ALLOWED.includes(key)).sort(),
      );
      expect(kept.filter((key) => key.startsWith("finance."))).toEqual([]);
      expect(kept.every((key) => key.endsWith(".org"))).toBe(true);
    },
  );

  it("the owner bundle (every key) keeps exactly the allowlist", () => {
    expect(externalOrgKeys(ROLES.owner).sort()).toEqual(
      [...EXPECTED_ALLOWED].sort(),
    );
  });

  it("an empty bundle keeps nothing", () => {
    expect(externalOrgKeys([])).toEqual([]);
  });
});

describe("externalAllowsElevation(key): never at org scope (Done-when 14)", () => {
  it("false for every org-scope key, the allowlisted ones included; true for project, site and own keys", () => {
    for (const key of CATALOGUE) {
      expect(externalAllowsElevation(key), key).toBe(!key.endsWith(".org"));
    }
  });

  it("false for anything that is not a catalogue key", () => {
    for (const key of ["", "finance.budget.approve", "nope.nope.nope.org"]) {
      expect(externalAllowsElevation(key)).toBe(false);
    }
  });
});
