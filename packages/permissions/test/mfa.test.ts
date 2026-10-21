// P5-05 (phase ruling D5, ADR 0066): MFA is required of anyone whose
// effective keys hold a finance.* key. The same rule, in SQL, is
// app.mfa_state() (packages/db); this is the API's and the oracle's copy.
import { describe, expect, it } from "vitest";
import { CATALOGUE } from "../src/catalogue.ts";
import { PermissionError } from "../src/errors.ts";
import { MFA_KEY_PREFIX, requiresMfa } from "../src/mfa.ts";
import { ROLE_IDS, ROLES } from "../src/roles.ts";

describe("requiresMfa(keys)", () => {
  it("true for any finance.* key, whatever its scope; false otherwise and for no keys", () => {
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

  it("the default bundles: owner and accountant require MFA; every finance.* catalogue key does", () => {
    const required = ROLE_IDS.filter((id) => requiresMfa(ROLES[id]));
    expect(required).toContain("owner");
    expect(required).toContain("accountant");
    expect(required.length).toBeLessThan(ROLE_IDS.length);
    // The computed answer equals the hand-written rule per role.
    for (const id of ROLE_IDS) {
      expect(requiresMfa(ROLES[id]), id).toBe(
        ROLES[id].some((k) => k.startsWith("finance.")),
      );
    }
    for (const key of CATALOGUE) {
      expect(requiresMfa([key]), key).toBe(key.startsWith("finance."));
    }
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
