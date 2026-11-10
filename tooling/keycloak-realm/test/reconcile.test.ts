// `pnpm keycloak:reconcile` (P6-05e, ADR 0081; owner conditions C5): how a
// running realm, imported once with IGNORE_EXISTING, receives the realm
// file's managed settings. Read-modify-write of the whole realm
// representation: GET it, set only the managed fields (one attribute set
// inside the existing attributes map, never a partial map), PUT it whole,
// read it back. Local only unless --allow-remote; output names fields,
// never values. realm-hardening.int.test.ts runs it against a live realm.
// P6-06 (ADR 0077, owner condition C2): the bricx-worker service account's
// realm-management roles (its user's mapping and its client's scope
// mapping) are managed as exact sets, with the same drift check.
import { describe, expect, test } from "vitest";
import { isObject, type Json } from "../src/normalise.js";
import {
  MANAGED_ATTRIBUTES,
  MANAGED_FIELDS,
  ROLE_SETS,
  ReconcileError,
  type RealmAdmin,
  type RoleSet,
  roleChanges,
  desiredSettings,
  driftOf,
  reconcile,
  report,
  targetOf,
  withDesired,
} from "../src/reconcile.js";
import { loadRealm } from "../src/realm.js";

const desired = desiredSettings(loadRealm());

/** The object without `keys` (a copy). */
const omit = (
  value: { readonly [key: string]: Json },
  keys: readonly string[],
): { [key: string]: Json } =>
  Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k)));

/** A live realm as the admin API returns it, with the old settings. */
const oldLive = (): { [key: string]: Json } => ({
  id: "realm-id",
  realm: "bricx",
  enabled: true,
  sslRequired: "external",
  bruteForceProtected: true,
  failureFactor: 5,
  otpPolicyType: "totp",
  webAuthnPolicyPasswordlessUserVerificationRequirement: "required",
  adminEventsEnabled: false,
  adminEventsDetailsEnabled: false,
  attributes: {
    "acr.loa.map": '{"pwd":1,"mfa":2}',
    frontendUrl: "",
  },
});

const WANTED_ROLES = ["manage-users", "view-users"];

function fakeAdmin(
  initial: { [key: string]: Json },
  roles: Readonly<Record<RoleSet, readonly string[]>> = {
    serviceAccount: WANTED_ROLES,
    scopeMappings: WANTED_ROLES,
  },
): RealmAdmin & {
  puts: Json[];
  gets: number;
  roleSets: Record<RoleSet, string[]>;
  changes: { set: RoleSet; add: string[]; remove: string[] }[];
} {
  let current: Json = structuredClone(initial);
  const admin = {
    puts: [] as Json[],
    gets: 0,
    roleSets: {
      serviceAccount: [...roles.serviceAccount],
      scopeMappings: [...roles.scopeMappings],
    },
    changes: [] as { set: RoleSet; add: string[]; remove: string[] }[],
    roles(set: RoleSet): Promise<string[]> {
      return Promise.resolve([...admin.roleSets[set]].sort());
    },
    changeRoles(
      set: RoleSet,
      _account: unknown,
      add: readonly string[],
      remove: readonly string[],
    ): Promise<void> {
      admin.changes.push({ set, add: [...add], remove: [...remove] });
      admin.roleSets[set] = [
        ...admin.roleSets[set].filter((r) => !remove.includes(r)),
        ...add,
      ];
      return Promise.resolve();
    },
    get(): Promise<Json> {
      admin.gets += 1;
      return Promise.resolve(structuredClone(current));
    },
    put(body: Json): Promise<void> {
      admin.puts.push(structuredClone(body));
      current = structuredClone(body);
      return Promise.resolve();
    },
  };
  return admin;
}

describe("the managed settings", () => {
  test("exactly the four approved: three fields and one attribute", () => {
    expect(MANAGED_FIELDS).toEqual([
      "passwordPolicy",
      "adminEventsEnabled",
      "adminEventsDetailsEnabled",
    ]);
    expect(MANAGED_ATTRIBUTES).toEqual(["adminEventsExpiration"]);
  });

  test("desiredSettings reads them from the realm file", () => {
    expect(desired).toEqual({
      fields: {
        passwordPolicy:
          "length(12) and maxLength(128) and notUsername(undefined) and notEmail(undefined) and passwordHistory(5) and passwordBlacklist(bricx-common-passwords.txt)",
        adminEventsEnabled: true,
        adminEventsDetailsEnabled: false,
      },
      attributes: { adminEventsExpiration: "31536000" },
      serviceAccount: {
        client: "bricx-worker",
        roleClient: "realm-management",
        roles: ["manage-users", "view-users"],
      },
    });
  });

  test("C2: the service account's roles are read from its user AND its client's scope mapping, which must agree", () => {
    const file = loadRealm();
    const mappings = file.clientScopeMappings as {
      [key: string]: Json;
    };
    const differing = {
      ...file,
      clientScopeMappings: {
        ...mappings,
        "realm-management": [
          { client: "bricx-worker", roles: ["manage-users"] },
        ],
      },
    };
    expect(() => desiredSettings(differing)).toThrow(
      expect.objectContaining({ code: "bad_realm_file" }),
    );
    expect(() => desiredSettings(omit(file, ["users"]))).toThrow(
      expect.objectContaining({ code: "bad_realm_file" }),
    );
    expect(ROLE_SETS).toEqual(["serviceAccount", "scopeMappings"]);
  });

  test("roleChanges: exact sets (add the missing, remove the extra)", () => {
    expect(roleChanges(["manage-users"], WANTED_ROLES)).toEqual({
      add: ["view-users"],
      remove: [],
    });
    expect(
      roleChanges(["manage-users", "realm-admin", "view-users"], WANTED_ROLES),
    ).toEqual({ add: [], remove: ["realm-admin"] });
    expect(roleChanges(WANTED_ROLES, WANTED_ROLES)).toEqual({
      add: [],
      remove: [],
    });
  });

  test("a realm file without a managed setting is refused (nothing to reconcile to)", () => {
    const rest = omit(loadRealm(), ["passwordPolicy"]);
    expect(() => desiredSettings(rest)).toThrow(ReconcileError);
  });
});

describe("targetOf (C5: local only unless --allow-remote)", () => {
  test.each([
    "http://localhost:8080/realms/bricx",
    "http://127.0.0.1:8080/realms/bricx",
    "http://[::1]:8080/realms/bricx",
  ])("%s is local", (issuer) => {
    expect(targetOf(issuer, false)).toEqual({
      base: new URL(issuer).origin,
      realm: "bricx",
    });
  });

  test("a remote issuer is refused without --allow-remote, accepted with it", () => {
    const issuer = "https://auth.af-south-1.example.test/realms/bricx";
    expect(() => targetOf(issuer, false)).toThrow(
      expect.objectContaining({ code: "remote_refused" }),
    );
    expect(targetOf(issuer, true)).toEqual({
      base: "https://auth.af-south-1.example.test",
      realm: "bricx",
    });
  });

  test("a look-alike host is remote", () => {
    for (const issuer of [
      "http://localhost.example.test/realms/bricx",
      "http://127.0.0.1.example.test/realms/bricx",
      "http://user@evil.example.test/realms/bricx",
    ]) {
      expect(() => targetOf(issuer, false), issuer).toThrow(ReconcileError);
    }
  });

  test("an issuer that is not /realms/<name> is refused, without echoing it", () => {
    for (const issuer of [
      "not a url",
      "http://localhost:8080/",
      "http://localhost:8080/realms/",
    ]) {
      let caught: unknown;
      try {
        targetOf(issuer, false);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "bad_issuer" });
      expect(String(caught)).not.toContain(issuer);
    }
  });
});

describe("driftOf and withDesired", () => {
  test("names every managed setting that differs, never a value", () => {
    expect(driftOf(oldLive(), desired)).toEqual([
      "passwordPolicy",
      "adminEventsEnabled",
      "attributes.adminEventsExpiration",
    ]);
  });

  test("withDesired sets only the managed settings; the attributes map keeps every other attribute", () => {
    const live = oldLive();
    const next = withDesired(live, desired);
    const managed = [
      "passwordPolicy",
      "adminEventsEnabled",
      "adminEventsDetailsEnabled",
      "attributes",
    ];
    expect(omit(next, managed)).toEqual(omit(live, managed));
    expect(next.passwordPolicy).toBe(desired.fields.passwordPolicy);
    expect(next.adminEventsEnabled).toBe(true);
    expect(next.adminEventsDetailsEnabled).toBe(false);
    expect(next.attributes).toEqual({
      ...(isObject(live.attributes) ? live.attributes : {}),
      adminEventsExpiration: "31536000",
    });
    // The input is not mutated.
    expect(live.adminEventsEnabled).toBe(false);
  });
});

describe("reconcile (read-modify-write)", () => {
  test("apply: one GET, one PUT of the WHOLE representation, one GET back; then in sync", async () => {
    const admin = fakeAdmin(oldLive());
    const result = await reconcile(admin, desired, "apply");
    expect(result).toEqual({
      drift: [
        "passwordPolicy",
        "adminEventsEnabled",
        "attributes.adminEventsExpiration",
      ],
      applied: [
        "passwordPolicy",
        "adminEventsEnabled",
        "attributes.adminEventsExpiration",
      ],
    });
    expect(admin.gets).toBe(2);
    expect(admin.puts).toEqual([withDesired(oldLive(), desired)]);
    const sent = admin.puts[0] as { [key: string]: Json };
    // Never a partial representation or attributes map.
    expect(Object.keys(sent).sort()).toEqual(
      [...new Set([...Object.keys(oldLive()), "passwordPolicy"])].sort(),
    );
    expect(Object.keys(sent.attributes as object).sort()).toEqual([
      "acr.loa.map",
      "adminEventsExpiration",
      "frontendUrl",
    ]);
    expect(await reconcile(admin, desired, "check")).toEqual({
      drift: [],
      applied: [],
    });
  });

  test("apply on a realm already in sync: no PUT", async () => {
    const admin = fakeAdmin(withDesired(oldLive(), desired));
    expect(await reconcile(admin, desired, "apply")).toEqual({
      drift: [],
      applied: [],
    });
    expect(admin.puts).toEqual([]);
  });

  test("check: reports the drift and writes nothing", async () => {
    const admin = fakeAdmin(oldLive());
    expect((await reconcile(admin, desired, "check")).drift).toHaveLength(3);
    expect(admin.puts).toEqual([]);
  });

  test("a realm that still drifts after the PUT is an error (Keycloak refused or ignored a field)", async () => {
    const admin = fakeAdmin(oldLive());
    const stubborn: RealmAdmin = {
      get: () => admin.get(),
      put: () => Promise.resolve(),
      roles: (set, account) => admin.roles(set, account),
      changeRoles: () => Promise.resolve(),
    };
    await expect(reconcile(stubborn, desired, "apply")).rejects.toMatchObject({
      code: "still_drifting",
    });
  });
});

describe("the service account's roles (C2: least privilege, drift checked)", () => {
  test("check: a missing role on the user and an extra one in the scope are drift, named by set; nothing changes", async () => {
    const admin = fakeAdmin(withDesired(oldLive(), desired), {
      serviceAccount: ["manage-users"],
      scopeMappings: ["manage-users", "realm-admin", "view-users"],
    });
    expect(await reconcile(admin, desired, "check")).toEqual({
      drift: ["serviceAccount.bricx-worker", "scopeMappings.bricx-worker"],
      applied: [],
    });
    expect(admin.changes).toEqual([]);
    expect(admin.puts).toEqual([]);
  });

  test("apply: adds the missing role, removes the extra one, no realm PUT when only roles drift; then in sync", async () => {
    const admin = fakeAdmin(withDesired(oldLive(), desired), {
      serviceAccount: ["manage-users"],
      scopeMappings: ["manage-users", "realm-admin", "view-users"],
    });
    const result = await reconcile(admin, desired, "apply");
    expect(result.applied).toEqual([
      "serviceAccount.bricx-worker",
      "scopeMappings.bricx-worker",
    ]);
    expect(admin.changes).toEqual([
      { set: "serviceAccount", add: ["view-users"], remove: [] },
      { set: "scopeMappings", add: [], remove: ["realm-admin"] },
    ]);
    expect(admin.puts).toEqual([]);
    expect(admin.roleSets.serviceAccount.sort()).toEqual(WANTED_ROLES);
    expect(admin.roleSets.scopeMappings.sort()).toEqual(WANTED_ROLES);
    expect((await reconcile(admin, desired, "check")).drift).toEqual([]);
  });

  test("roles that still drift after apply are an error", async () => {
    const admin = fakeAdmin(withDesired(oldLive(), desired), {
      serviceAccount: ["manage-users"],
      scopeMappings: WANTED_ROLES,
    });
    const stubborn: RealmAdmin = {
      get: () => admin.get(),
      put: (body) => admin.put(body),
      roles: (set, account) => admin.roles(set, account),
      changeRoles: () => Promise.resolve(),
    };
    await expect(reconcile(stubborn, desired, "apply")).rejects.toMatchObject({
      code: "still_drifting",
    });
  });
});

describe("report (C5: field names, never values)", () => {
  test("in sync, applied and drift lines carry no managed value", () => {
    const lines = [
      ...report({ drift: [], applied: [] }, "apply"),
      ...report(
        { drift: ["passwordPolicy"], applied: ["passwordPolicy"] },
        "apply",
      ),
      ...report(
        { drift: ["attributes.adminEventsExpiration"], applied: [] },
        "check",
      ),
    ];
    expect(lines).toEqual([
      "keycloak:reconcile: in sync",
      "keycloak:reconcile: applied passwordPolicy",
      "keycloak:reconcile: drift attributes.adminEventsExpiration",
    ]);
    const all = lines.join("\n");
    expect(all).not.toContain("length(12)");
    expect(all).not.toContain("31536000");
  });
});
