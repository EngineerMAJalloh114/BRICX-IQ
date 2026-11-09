// P5-05 (phase ruling D5, ADR 0066): MFA is required of anyone whose
// effective keys hold a finance.* key. P6-05e (ADR 0081, owner condition
// C2) adds the org-admin keys: a per-key flag (MFA_ADMIN_PERMISSIONS),
// pulled forward from P13-01. The same rule, in SQL, is app.mfa_state() v3
// (packages/db); this is the API's and the oracle's copy.
import { describe, expect, it } from "vitest";
import { CATALOGUE, PERMISSIONS } from "../src/catalogue.ts";
import { PermissionError } from "../src/errors.ts";
import {
  ADMIN_CLASS_EXEMPT,
  MFA_ADMIN_KEYS,
  MFA_ADMIN_PERMISSIONS,
  MFA_KEY_PREFIX,
  isAdminClass,
  requiresMfa,
} from "../src/mfa.ts";
import { ROLE_IDS, ROLES } from "../src/roles.ts";

/** The admin-class permissions, written out (C2): a change here is a review. */
const EXPECTED_ADMIN = [
  "org.organization.update",
  "org.organization.archive",
  "org.member.invite",
  "org.member.update",
  "org.member.remove",
  "org.role.manage",
  "org.session.revoke",
  "org.access_grant.grant",
  "org.access_grant.revoke",
  "org.region_config.update",
  "org.audit.export",
  "project.member.assign",
  "report.dashboard.export",
];

const permissionOf = (key: string) => key.split(".").slice(0, 3).join(".");

describe("requiresMfa(keys): finance.* (P5-05)", () => {
  it("true for any finance.* key, whatever its scope; false for no keys", () => {
    expect(MFA_KEY_PREFIX).toBe("finance.");
    expect(requiresMfa(["finance.budget.read.org"])).toBe(true);
    expect(
      requiresMfa(["project.task.read.org", "finance.payment.approve.project"]),
    ).toBe(true);
    expect(requiresMfa(["finance.expenditure.read.own"])).toBe(true);
    expect(requiresMfa(["project.task.read.org", "org.member.read.org"])).toBe(
      false,
    );
    expect(requiresMfa([])).toBe(false);
  });

  it("matches the prefix exactly: a module merely starting with 'finance' does not count", () => {
    expect(requiresMfa(["financex.budget.read.org"])).toBe(false);
    expect(requiresMfa(["xfinance.budget.read.org"])).toBe(false);
    expect(requiresMfa(["finance"])).toBe(false);
    expect(requiresMfa(["Finance.budget.read.org"])).toBe(false);
  });

  it("refuses more keys than the catalogue holds, before reading them", () => {
    const tooMany: unknown[] = [];
    tooMany.length = CATALOGUE.length + 1;
    let caught: unknown;
    try {
      requiresMfa(tooMany as string[]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PermissionError);
    expect(caught).toMatchObject({ code: "too_many_keys" });
  });
});

describe("requiresMfa(keys): the org-admin keys (P6-05e, ADR 0081, C2)", () => {
  it("MFA_ADMIN_PERMISSIONS is exactly the reviewed list, every entry a catalogue permission", () => {
    expect([...MFA_ADMIN_PERMISSIONS].sort()).toEqual(
      [...EXPECTED_ADMIN].sort(),
    );
    for (const permission of MFA_ADMIN_PERMISSIONS) {
      expect(PERMISSIONS as readonly string[], permission).toContain(
        permission,
      );
    }
  });

  it("an admin permission requires MFA as a bare permission (the guard's form) and as a key at every scope", () => {
    for (const permission of MFA_ADMIN_PERMISSIONS) {
      expect(requiresMfa([permission]), permission).toBe(true);
    }
    for (const key of MFA_ADMIN_KEYS) {
      expect(requiresMfa([key]), key).toBe(true);
    }
    expect(requiresMfa(["project.member.assign.project"])).toBe(true);
    expect(requiresMfa(["org.member.invite.org"])).toBe(true);
  });

  it("MFA_ADMIN_KEYS is every catalogue key of an admin permission, at every scope it allows", () => {
    expect([...MFA_ADMIN_KEYS].sort()).toEqual(
      CATALOGUE.filter((key) =>
        (MFA_ADMIN_PERMISSIONS as readonly string[]).includes(
          permissionOf(key),
        ),
      ).sort(),
    );
    expect(MFA_ADMIN_KEYS).toContain("project.member.assign.org");
    expect(MFA_ADMIN_KEYS).toContain("project.member.assign.project");
  });

  it("self-service and reads stay out (C1): no read, no own-scope key, no key of the caller's own sessions or devices", () => {
    for (const key of CATALOGUE) {
      const action = key.split(".")[2];
      if (key.startsWith(MFA_KEY_PREFIX)) continue;
      if (action === "read") expect(requiresMfa([key]), key).toBe(false);
      if (key.endsWith(".own")) expect(requiresMfa([key]), key).toBe(false);
    }
    expect(requiresMfa(["org.session.read"])).toBe(false);
    expect(requiresMfa(["org.member.read.org"])).toBe(false);
  });

  it("a malformed or unknown key is never an admin key", () => {
    expect(requiresMfa(["org.member.invite.orgx"])).toBe(false);
    expect(requiresMfa(["org.member"])).toBe(false);
    expect(requiresMfa(["org.member.invite.org.extra"])).toBe(false);
    expect(requiresMfa(["Org.member.invite.org"])).toBe(false);
  });

  it("every catalogue key: required exactly when finance.* or of an admin permission", () => {
    for (const key of CATALOGUE) {
      expect(requiresMfa([key]), key).toBe(
        key.startsWith("finance.") ||
          EXPECTED_ADMIN.includes(permissionOf(key)),
      );
    }
  });

  it("the default bundles: owner and every role holding an admin key require MFA; site roles do not", () => {
    for (const id of ROLE_IDS) {
      expect(requiresMfa(ROLES[id]), id).toBe(
        ROLES[id].some(
          (k) =>
            k.startsWith("finance.") ||
            EXPECTED_ADMIN.includes(permissionOf(k)),
        ),
      );
    }
    expect(requiresMfa(ROLES.owner)).toBe(true);
    expect(requiresMfa(ROLES.site_engineer)).toBe(false);
    expect(requiresMfa(ROLES.foreman)).toBe(false);
  });
});

describe("completeness (C2): every admin-class permission is listed or exempted with a reason", () => {
  it("the admin-class pattern: non-read actions on member, role, grant, session, organisation, region-config and audit resources; every export, manage, grant, invite, assign, revoke, remove or share action", () => {
    expect(isAdminClass("org.member.invite")).toBe(true);
    expect(isAdminClass("org.member.read")).toBe(false);
    expect(isAdminClass("project.member.assign")).toBe(true);
    expect(isAdminClass("finance.ledger.export")).toBe(true);
    expect(isAdminClass("document.file.share")).toBe(true);
    expect(isAdminClass("project.task.update")).toBe(false);
    // A future key of these shapes is admin-class (P6-06 adds keys).
    expect(isAdminClass("org.invitation.revoke")).toBe(true);
    expect(isAdminClass("org.member.suspend")).toBe(true);
    expect(isAdminClass("project.role.manage")).toBe(true);
    expect(isAdminClass("supply.inventory.export")).toBe(true);
  });

  it("every admin-class catalogue permission is finance.* (already MFA), in MFA_ADMIN_PERMISSIONS, or in ADMIN_CLASS_EXEMPT with a reason", () => {
    const unlisted = PERMISSIONS.filter(
      (permission) =>
        isAdminClass(permission) &&
        !permission.startsWith(MFA_KEY_PREFIX) &&
        !(MFA_ADMIN_PERMISSIONS as readonly string[]).includes(permission) &&
        !Object.hasOwn(ADMIN_CLASS_EXEMPT, permission),
    );
    expect(unlisted).toEqual([]);
  });

  it("every MFA_ADMIN_PERMISSIONS entry is admin-class; an exemption is a catalogue permission, admin-class, not listed, with a reason of a sentence", () => {
    for (const permission of MFA_ADMIN_PERMISSIONS) {
      expect(isAdminClass(permission), permission).toBe(true);
    }
    for (const [permission, reason] of Object.entries(ADMIN_CLASS_EXEMPT)) {
      expect(PERMISSIONS as readonly string[], permission).toContain(
        permission,
      );
      expect(isAdminClass(permission), permission).toBe(true);
      expect(
        (MFA_ADMIN_PERMISSIONS as readonly string[]).includes(permission),
        permission,
      ).toBe(false);
      expect(reason.length, permission).toBeGreaterThan(20);
    }
  });

  it("the lists are frozen", () => {
    expect(Object.isFrozen(MFA_ADMIN_PERMISSIONS)).toBe(true);
    expect(Object.isFrozen(MFA_ADMIN_KEYS)).toBe(true);
    expect(Object.isFrozen(ADMIN_CLASS_EXEMPT)).toBe(true);
  });
});
