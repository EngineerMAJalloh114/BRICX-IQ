// P6-05e Done-when (ADR 0081; owner conditions C5, C7), live against the
// realm as compose.yml starts it (the same Dockerfile, command and env):
// - the password policy refuses each weak password through the admin API
//   (the admin path does not bypass it, C7) and through the user's own
//   update-password form; a strong one is accepted;
// - an admin action is an admin event, and no credential value or
//   representation is in any event;
// - a realm imported from the OLD file (no policy, no admin events) is
//   brought to the new settings by `pnpm keycloak:reconcile` (the real CLI),
//   and every unmanaged setting is byte-identical afterwards (C5);
// - Keycloak does not start when the denylist file is missing (C7, S5).
// Import idempotency stays proven by realm-import.int.test.ts (two fresh
// imports identical, every file value held); here a fresh import is also
// "in sync" for reconcile. Hooks get 600 s (P5-01 condition 1).
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { isArray, isObject, type Json, normalise } from "../src/normalise.js";
import { MANAGED_ATTRIBUTES, MANAGED_FIELDS } from "../src/reconcile.js";
import { loadRealm, repoRoot } from "../src/realm.js";
import { Browser, formAction, pkce } from "./browser.js";
import {
  exportRealm,
  type Keycloak,
  keycloakImage,
  keycloakService,
  startKeycloak,
} from "./keycloak.js";

const HOOK_MS = 600_000;
/** The admin-set temporary password the update-password test replaces. */
const TEMPORARY_PASSWORD = "test-only-temporary-pw-1";
const run = promisify(execFile);
const redirect = keycloakService.environment.KEYCLOAK_WEB_REDIRECT_URI ?? "";

let fresh: Keycloak | undefined;
let old: Keycloak | undefined;
const kc = (): Keycloak => {
  if (fresh === undefined) throw new Error("Keycloak did not start");
  return fresh;
};

/**
 * The committed realm file without the four managed settings, and the
 * service account with manage-users only (before P6-06, C2): the realm as
 * main had it.
 */
function oldRealmFile(): string {
  const file = loadRealm();
  const attributes = isObject(file.attributes) ? file.attributes : {};
  const oldAttributes = Object.fromEntries(
    Object.entries(attributes).filter(
      ([key]) => !(MANAGED_ATTRIBUTES as readonly string[]).includes(key),
    ),
  );
  const oldRoles = { "realm-management": ["manage-users"] };
  const oldFile = Object.fromEntries(
    Object.entries(file)
      .filter(([key]) => !(MANAGED_FIELDS as readonly string[]).includes(key))
      .map(([key, value]) =>
        key === "attributes"
          ? [key, oldAttributes]
          : key === "clientScopeMappings"
            ? [
                key,
                {
                  "realm-management": [
                    { client: "bricx-worker", roles: ["manage-users"] },
                  ],
                },
              ]
            : key === "users" && isArray(value)
              ? [
                  key,
                  value.map((u) =>
                    isObject(u) && u.serviceAccountClientId === "bricx-worker"
                      ? { ...u, clientRoles: oldRoles }
                      : u,
                  ),
                ]
              : [key, value],
      ),
  );
  const dir = mkdtempSync(path.join(tmpdir(), "bricx-old-realm-"));
  const out = path.join(dir, "realm-bricx.json");
  writeFileSync(out, JSON.stringify({ ...oldFile, adminEventsEnabled: false }));
  return out;
}

/** `pnpm keycloak:reconcile` against `keycloak`, as the runbook runs it. */
async function reconcileCli(
  keycloak: Keycloak,
  args: string[],
): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await run(
      path.join(repoRoot, "node_modules/.bin/tsx"),
      [
        path.join(repoRoot, "tooling/keycloak-realm/src/reconcile-cli.ts"),
        ...args,
      ],
      {
        cwd: repoRoot,
        env: {
          PATH: process.env.PATH ?? "",
          KEYCLOAK_ISSUER: `${keycloak.base.replace("localhost", "127.0.0.1")}/realms/bricx`,
          KEYCLOAK_ADMIN_USERNAME: keycloak.adminCredentials.username,
          KEYCLOAK_ADMIN_PASSWORD: keycloak.adminCredentials.password,
        },
      },
    );
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === "number" ? failed.code : -1,
      out: `${failed.stdout ?? ""}${failed.stderr ?? ""}`,
    };
  }
}

const realmOf = async (keycloak: Keycloak) =>
  (await keycloak.admin("GET", "")) as { [key: string]: Json };

/** A realm representation without the managed settings: what must not move. */
function unmanaged(realm: { [key: string]: Json }): Json {
  const attributes = isObject(realm.attributes) ? realm.attributes : {};
  return {
    ...Object.fromEntries(
      Object.entries(realm).filter(
        ([key]) =>
          !(MANAGED_FIELDS as readonly string[]).includes(key) &&
          key !== "attributes",
      ),
    ),
    attributes: Object.fromEntries(
      Object.entries(attributes).filter(
        ([key]) => !(MANAGED_ATTRIBUTES as readonly string[]).includes(key),
      ),
    ),
  };
}

let userCounter = 0;
async function createUser(
  keycloak: Keycloak,
  password: string,
  name?: string,
): Promise<{ status: number; error: string; username: string }> {
  userCounter += 1;
  const username = name ?? `hardening-user-${String(userCounter)}`;
  const { status, text } = await keycloak.adminRaw("POST", "/users", {
    username,
    email: `${username}@example.test`,
    firstName: "Test",
    lastName: "User",
    enabled: true,
    emailVerified: true,
    credentials: [{ type: "password", value: password, temporary: false }],
  });
  const body = text === "" ? {} : (JSON.parse(text) as { error?: string });
  return { status, error: body.error ?? "", username };
}

async function userId(keycloak: Keycloak, username: string): Promise<string> {
  const found = await keycloak.admin(
    "GET",
    `/users?username=${encodeURIComponent(username)}&exact=true`,
  );
  const user = isArray(found) ? found[0] : undefined;
  const id = isObject(user) ? user.id : undefined;
  if (typeof id !== "string") throw new Error(`no user ${username}`);
  return id;
}

async function resetPassword(
  keycloak: Keycloak,
  id: string,
  value: string,
): Promise<{ status: number; error: string }> {
  const { status, text } = await keycloak.adminRaw(
    "PUT",
    `/users/${id}/reset-password`,
    { type: "password", value, temporary: false },
  );
  const body = text === "" ? {} : (JSON.parse(text) as { error?: string });
  return { status, error: body.error ?? "" };
}

beforeAll(async () => {
  [fresh, old] = await Promise.all([
    startKeycloak(),
    startKeycloak(oldRealmFile()),
  ]);
}, HOOK_MS);

afterAll(async () => {
  await fresh?.container.stop();
  await old?.container.stop();
}, HOOK_MS);

describe("the password policy, through the admin API (C7: the admin path is held to it)", () => {
  test("T1 too short: 11 characters is refused, 12 is accepted", async () => {
    expect(await createUser(kc(), "Xq7-pLm2-zR9")).toMatchObject({
      status: 201,
    });
    expect(await createUser(kc(), "Xq7-pLm2-zR")).toMatchObject({
      status: 400,
      error: "invalidPasswordMinLengthMessage",
    });
  });

  test("T1b longer than 128 is refused", async () => {
    expect(await createUser(kc(), `Xq7-${"a".repeat(125)}`)).toMatchObject({
      status: 400,
      error: "invalidPasswordMaxLengthMessage",
    });
  });

  test("T2 equal to the username is refused", async () => {
    const name = "hardening-same-as-name";
    expect(await createUser(kc(), name, name)).toMatchObject({
      status: 400,
      error: "invalidPasswordNotUsernameMessage",
    });
  });

  test("T3 equal to the e-mail is refused", async () => {
    const name = "hardening-mail";
    expect(await createUser(kc(), `${name}@example.test`, name)).toMatchObject({
      status: 400,
      error: "invalidPasswordNotEmailMessage",
    });
  });

  test("T4 a denylisted password of 12+ characters is refused, in any letter case", async () => {
    for (const password of ["unbelievable", "Unbelievable", "SCANDINAVIAN"]) {
      expect(await createUser(kc(), password), password).toMatchObject({
        status: 400,
        error: "invalidPasswordBlacklistedMessage",
      });
    }
  });

  test("T5 a password reused from the last 5 is refused; the 6th back is allowed", async () => {
    const created = await createUser(kc(), "History-Pass-000");
    expect(created.status).toBe(201);
    const id = await userId(kc(), created.username);
    for (const n of [1, 2, 3, 4, 5]) {
      expect(
        await resetPassword(kc(), id, `History-Pass-00${String(n)}`),
      ).toMatchObject({ status: 204 });
    }
    expect(await resetPassword(kc(), id, "History-Pass-002")).toMatchObject({
      status: 400,
      error: "invalidPasswordHistoryMessage",
    });
    expect(await resetPassword(kc(), id, "History-Pass-000")).toMatchObject({
      status: 204,
    });
  });

  test("T6 a strong password is accepted (create and reset)", async () => {
    const created = await createUser(kc(), "Correct-Horse-Battery-71");
    expect(created.status).toBe(201);
    const id = await userId(kc(), created.username);
    expect(
      await resetPassword(kc(), id, "Another-Strong-Phrase-42"),
    ).toMatchObject({ status: 204 });
  });

  test("a refused create leaves no user behind", async () => {
    const refused = await createUser(kc(), "short-pw-1");
    expect(refused.status).toBe(400);
    const found = await kc().admin(
      "GET",
      `/users?username=${refused.username}&exact=true`,
    );
    expect(found).toEqual([]);
  });
});

describe("the password policy, through the user's own update-password form", () => {
  test("a too-short and a denylisted new password are refused; a strong one signs in", async () => {
    const created = await createUser(kc(), "Temporary-Pass-123");
    expect(created.status).toBe(201);
    const id = await userId(kc(), created.username);
    await kc().admin("PUT", `/users/${id}/reset-password`, {
      type: "password",
      value: TEMPORARY_PASSWORD,
      temporary: true,
    });
    const browser = new Browser(kc().base);
    const { challenge } = pkce();
    const query = new URLSearchParams({
      client_id: "bricx-client",
      redirect_uri: redirect,
      response_type: "code",
      scope: "openid",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "state",
      nonce: "nonce",
    });
    const login = await browser.request(
      `/realms/bricx/protocol/openid-connect/auth?${query.toString()}`,
    );
    let page = await browser.follow(
      await browser.request(formAction(login), {
        username: created.username,
        password: TEMPORARY_PASSWORD,
        credentialId: "",
      }),
    );
    expect(page.body).toContain("password-new");
    for (const weak of ["Short-pw-1", "unbelievable"]) {
      page = await browser.follow(
        await browser.request(formAction(page), {
          "password-new": weak,
          "password-confirm": weak,
        }),
      );
      expect(page.status, weak).toBe(200);
      expect(page.body, weak).toContain("password-new");
    }
    page = await browser.follow(
      await browser.request(formAction(page), {
        "password-new": "Brand-New-Strong-Phrase-9",
        "password-confirm": "Brand-New-Strong-Phrase-9",
      }),
    );
    expect(page.status).toBe(302);
    expect(page.location.startsWith(redirect)).toBe(true);
  });
});

describe("admin events (no credential value, no representation)", () => {
  test("T7 creating a user with a password, resetting it and regenerating a client secret are admin events; no secret and no representation is in any event", async () => {
    const sentinels = ["Sentinel-Create-Pass-91", "Sentinel-Reset-Pass-92"];
    const created = await createUser(kc(), sentinels[0] ?? "");
    expect(created.status).toBe(201);
    const id = await userId(kc(), created.username);
    expect(await resetPassword(kc(), id, sentinels[1] ?? "")).toMatchObject({
      status: 204,
    });
    const clients = await kc().admin("GET", "/clients?clientId=bricx-worker");
    const worker = isArray(clients) ? clients[0] : undefined;
    const clientId = isObject(worker) ? worker.id : undefined;
    if (typeof clientId !== "string") throw new Error("no bricx-worker");
    const secret = await kc().admin(
      "POST",
      `/clients/${clientId}/client-secret`,
    );
    const value = isObject(secret) ? secret.value : undefined;
    expect(typeof value).toBe("string");

    const { status, text } = await kc().adminRaw(
      "GET",
      "/admin-events?max=1000",
    );
    expect(status).toBe(200);
    const events = JSON.parse(text) as {
      operationType: string;
      resourceType: string;
      resourcePath: string;
      representation?: string;
    }[];
    const paths = events.map(
      (e) => `${e.operationType} ${e.resourceType} ${e.resourcePath}`,
    );
    expect(paths).toContain(`CREATE USER users/${id}`);
    expect(paths).toContain(`ACTION USER users/${id}/reset-password`);
    expect(
      paths.some((p) => p.endsWith(`clients/${clientId}/client-secret`)),
    ).toBe(true);
    expect(events.every((e) => e.representation === undefined)).toBe(true);
    if (typeof value !== "string") throw new Error("no client secret value");
    for (const secretValue of [...sentinels, value]) {
      expect(
        text.includes(secretValue),
        "a secret value is in the events",
      ).toBe(false);
    }
  });

  test("T10 the realm keeps admin events 365 days, with details off", async () => {
    const realm = await realmOf(kc());
    expect(realm.adminEventsEnabled).toBe(true);
    expect(realm.adminEventsDetailsEnabled).toBe(false);
    expect(
      isObject(realm.attributes) && realm.attributes.adminEventsExpiration,
    ).toBe("31536000");
  });
});

describe("a running realm receives the change (C5): pnpm keycloak:reconcile", () => {
  test("T8 a fresh import of the file is already in sync", async () => {
    const check = await reconcileCli(kc(), ["--check"]);
    expect(check, check.out).toMatchObject({ code: 0 });
    expect(check.out).toContain("keycloak:reconcile: in sync");
  });

  test("T9 a realm with the OLD settings: --check exits 1 naming the fields; apply brings it to the file; unmanaged settings byte-identical; the policy then holds", async () => {
    if (old === undefined) throw new Error("the old realm did not start");
    const before = await realmOf(old);
    expect(before.passwordPolicy ?? "").toBe("");
    expect(before.adminEventsEnabled).toBe(false);
    const exportBefore = await exportRealm(old);
    // The old realm accepts a weak password.
    expect((await createUser(old, "weak-but-ok")).status).toBe(201);

    const check = await reconcileCli(old, ["--check"]);
    expect(check.code, check.out).toBe(1);
    expect(check.out).toContain("drift passwordPolicy");
    expect(check.out).toContain("drift adminEventsEnabled");
    expect(check.out).toContain("drift attributes.adminEventsExpiration");
    // P6-06 (C2): the service account lacks view-users on its user and in
    // its client's scope mapping.
    expect(check.out).toContain("drift serviceAccount.bricx-worker");
    expect(check.out).toContain("drift scopeMappings.bricx-worker");

    const apply = await reconcileCli(old, []);
    expect(apply.code, apply.out).toBe(0);
    expect(apply.out).toContain("applied passwordPolicy");
    expect(apply.out).toContain("applied serviceAccount.bricx-worker");
    expect(apply.out).toContain("applied scopeMappings.bricx-worker");
    // Field names only, never a value.
    expect(apply.out).not.toContain("length(12)");
    expect(apply.out).not.toContain("31536000");

    const after = await realmOf(old);
    const file = loadRealm();
    expect(after.passwordPolicy).toBe(file.passwordPolicy);
    expect(after.adminEventsEnabled).toBe(true);
    expect(after.adminEventsDetailsEnabled).toBe(false);
    expect(
      isObject(after.attributes) && after.attributes.adminEventsExpiration,
    ).toBe("31536000");
    // C5: every unmanaged top-level setting (brute-force, sslRequired, OTP
    // and WebAuthn policy, ...) and the clients, flows and scopes are
    // byte-identical. The attributes map keeps every attribute it had
    // (acr.loa.map included) with the same value. Finding (Keycloak
    // 26.7.5): any whole-realm PUT, the admin console's Save included,
    // also stores a few top-level settings as attributes of the same
    // value (clientOfflineSession*, scimApiEnabled); those may appear, and
    // only with the top-level field's value.
    const { attributes: attrsAfter, ...topAfter } = unmanaged(after) as {
      [key: string]: Json;
    };
    const { attributes: attrsBefore, ...topBefore } = unmanaged(before) as {
      [key: string]: Json;
    };
    expect(JSON.stringify(topAfter)).toBe(JSON.stringify(topBefore));
    const was = isObject(attrsBefore) ? attrsBefore : {};
    const now = isObject(attrsAfter) ? attrsAfter : {};
    for (const [key, value] of Object.entries(was)) {
      expect(now[key], `attribute ${key}`).toBe(value);
    }
    for (const [key, value] of Object.entries(now)) {
      if (key in was) continue;
      const mirrored = topBefore[key];
      const text =
        typeof mirrored === "number" || typeof mirrored === "boolean"
          ? String(mirrored)
          : undefined;
      expect(text, `added attribute ${key} mirrors a top-level setting`).toBe(
        value,
      );
    }
    for (const key of [
      "bruteForceProtected",
      "failureFactor",
      "sslRequired",
      "otpPolicyType",
      "webAuthnPolicyPasswordlessUserVerificationRequirement",
    ]) {
      expect(after[key], key).toEqual(before[key]);
    }
    const exportAfter = await exportRealm(old);
    for (const key of [
      "clients",
      "clientScopes",
      "authenticationFlows",
      "roles",
    ]) {
      const a = isObject(exportAfter) ? exportAfter[key] : undefined;
      const b = isObject(exportBefore) ? exportBefore[key] : undefined;
      expect(JSON.stringify(normalise(a ?? null)), key).toBe(
        JSON.stringify(normalise(b ?? null)),
      );
    }

    expect((await reconcileCli(old, ["--check"])).code).toBe(0);
    expect(await createUser(old, "weak-now-no")).toMatchObject({
      status: 400,
      error: "invalidPasswordMinLengthMessage",
    });
    expect(await createUser(old, "unbelievable")).toMatchObject({
      status: 400,
      error: "invalidPasswordBlacklistedMessage",
    });
  });

  test("the CLI refuses a non-local Keycloak without --allow-remote, before any request", async () => {
    const { stdout, stderr } = await run(
      path.join(repoRoot, "node_modules/.bin/tsx"),
      [
        path.join(repoRoot, "tooling/keycloak-realm/src/reconcile-cli.ts"),
        "--check",
      ],
      {
        cwd: repoRoot,
        env: {
          PATH: process.env.PATH ?? "",
          KEYCLOAK_ISSUER: "https://auth.example.test/realms/bricx",
          KEYCLOAK_ADMIN_USERNAME: "nobody",
          KEYCLOAK_ADMIN_PASSWORD: "nothing-at-all",
        },
      },
    ).then(
      () => ({ stdout: "unexpected success", stderr: "" }),
      (error: unknown) => {
        const failed = error as {
          code?: number;
          stdout?: string;
          stderr?: string;
        };
        return {
          stdout: `${String(failed.code)} ${failed.stdout ?? ""}`,
          stderr: failed.stderr ?? "",
        };
      },
    );
    expect(stdout.startsWith("2 ")).toBe(true);
    expect(stderr).toContain("remote_refused");
    expect(stderr).not.toContain("nothing-at-all");
  });
});

describe("fail closed (C7, S5): no denylist file, no Keycloak", () => {
  test(
    "with the denylist path pointing at a folder without the file, Keycloak exits 1 at import and never becomes ready",
    async () => {
      const container = await (
        await keycloakImage()
      )
        .withCommand(keycloakService.command ?? [])
        .withEnvironment({
          ...keycloakService.environment,
          KC_BOOTSTRAP_ADMIN_USERNAME: "bootstrap-test",
          KC_BOOTSTRAP_ADMIN_PASSWORD: "throwaway-test-only-1",
          KC_SPI_PASSWORD_POLICY__PASSWORD_BLACKLIST__BLACKLISTS_PATH:
            "/opt/keycloak/providers",
        })
        .withBindMounts([
          {
            source: path.join(
              repoRoot,
              "infrastructure/keycloak/realm-bricx.json",
            ),
            target: "/opt/keycloak/data/import/realm-bricx.json",
            mode: "ro",
          },
        ])
        .withExposedPorts(8080, 9000)
        .withWaitStrategy(
          Wait.forLogMessage(/Failed to start server/).withStartupTimeout(
            300_000,
          ),
        )
        .start();
      try {
        const logs: string[] = [];
        const stream = await container.logs();
        await new Promise<void>((resolve) => {
          stream.on("data", (line: Buffer | string) => logs.push(String(line)));
          stream.on("end", resolve);
          setTimeout(resolve, 20_000);
        });
        expect(logs.join("")).toContain(
          "Password denylist bricx-common-passwords.txt not found",
        );
        const { stdout } = await run("docker", [
          "inspect",
          "--format",
          "{{.State.Status}} {{.State.ExitCode}}",
          container.getId(),
        ]);
        expect(stdout.trim()).toBe("exited 1");
      } finally {
        await container.stop().catch(() => undefined);
      }
    },
    HOOK_MS,
  );
});
