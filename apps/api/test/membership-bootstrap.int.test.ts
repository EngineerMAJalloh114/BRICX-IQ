// membership:bootstrap (P5-05, ADR 0066; plan 3.4, D-F): the built CLI
// makes an org's first owner: the twelve roles (owner virtual, the other
// eleven bundles copied as open role_permissions rows), the owner
// membership, one org.member.bootstrap audit event (actor = the new
// owner) and one users.mfa_check outbox row, in one transaction as
// bricx_app; refused unless the org has no membership row at all (exit
// 1); usage and config errors exit 2 naming no value. The new owner can
// then use the API in that org.
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { loadApiConfig } from "@bricx/config/api";
import {
  type BootstrappedPostgres,
  appDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { migrate } from "@bricx/db/migrate";
import { ROLE_IDS, ROLES } from "@bricx/permissions/roles";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";
import {
  TestIssuer,
  bearer,
  fixedRevocations,
  seedUsers,
} from "./support/auth.js";

const HOOK_MS = 300_000;
const ORG = "0199e1a0-0000-7000-8000-0000000000c1";
const OTHER_ORG = "0199e1a0-0000-7000-8000-0000000000c2";
const OWNER = "0199e1a0-0000-7000-8000-0000000000d1";
const OTHER = "0199e1a0-0000-7000-8000-0000000000d2";
const appDir = path.resolve(import.meta.dirname, "..");
const outDir = path.join(appDir, "dist");

let pg18: BootstrappedPostgres;
let issuer: TestIssuer;
let app: NestFastifyApplication;

const urlFor = (role: string, key: string) =>
  `postgres://${role}:${exampleValue(key)}@${pg18.container.getHost()}:${String(pg18.container.getMappedPort(5432))}/${appDatabase}`;

async function asAdmin<R extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  const admin = await pg18.admin();
  try {
    return (await admin.query<R>(text, params)).rows;
  } finally {
    await admin.end();
  }
}

/** Runs the built membership:bootstrap CLI. */
function runBootstrap(
  args: string[],
  env: Record<string, string> = apiEnv({
    DATABASE_URL: urlFor("bricx_app", "BRICX_APP_PASSWORD"),
  }),
): Promise<{ code: number | null; output: string }> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      path.join(outDir, "register.js"),
      path.join(outDir, "membership-bootstrap.js"),
      ...args,
    ],
    {
      cwd: appDir,
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: "pipe",
    },
  );
  let output = "";
  child.stdout.on("data", (d: Buffer) => (output += d.toString("utf8")));
  child.stderr.on("data", (d: Buffer) => (output += d.toString("utf8")));
  return new Promise((resolve) => {
    child.on("close", (code) => {
      resolve({ code, output });
    });
  });
}

beforeAll(async () => {
  execFileSync(
    process.execPath,
    [
      path.resolve(appDir, "../../node_modules/typescript/bin/tsc"),
      "-p",
      path.join(appDir, "tsconfig.build.json"),
    ],
    { cwd: appDir, stdio: "pipe" },
  );
  [pg18, issuer] = await Promise.all([startPostgres(), TestIssuer.start()]);
  await migrate({
    reveal: () => urlFor("bricx_owner", "BRICX_OWNER_PASSWORD"),
  });
  await seedUsers(asAdmin, [
    { id: OWNER, sub: `boot-${OWNER}` },
    { id: OTHER, sub: `boot-${OTHER}` },
  ]);
  app = await createApp(
    loadApiConfig(
      apiEnv({
        ...issuer.env(),
        DATABASE_URL: urlFor("bricx_app", "BRICX_APP_PASSWORD"),
      }),
    ),
    { probes: fakeProbes(), revocationStore: fixedRevocations() },
  );
  await app.init();
}, HOOK_MS);
afterAll(async () => {
  await app.close().catch(() => undefined);
  await issuer.close();
  await pg18.container.stop();
}, HOOK_MS);

describe("membership:bootstrap (the built CLI)", () => {
  test("an empty org: twelve roles, the owner membership, one audit event by the new owner, one users.mfa_check row; exit 0 naming the ids; the owner then reads the org's members and roles", async () => {
    const run = await runBootstrap(["--org", ORG, "--user", OWNER]);
    expect(run.code, run.output).toBe(0);
    const roles = await asAdmin<{
      key: string;
      system_key: string | null;
      n: number;
    }>(
      `SELECT r.key, r.system_key, (SELECT count(*)::int FROM bricx.role_permissions p WHERE p.role_id = r.id AND p.revoked_at IS NULL) AS n
       FROM bricx.roles r WHERE r.org_id = $1 ORDER BY r.key`,
      [ORG],
    );
    expect(roles.map((r) => r.key)).toEqual([...ROLE_IDS].sort());
    for (const role of roles) {
      expect(role.system_key).toBe(role.key);
      expect(role.n).toBe(
        role.key === "owner"
          ? 0
          : ROLES[role.key as (typeof ROLE_IDS)[number]].length,
      );
    }
    const members = await asAdmin<{
      id: string;
      user_id: string;
      role_id: string;
      removed_at: unknown;
    }>(
      "SELECT m.id::text, m.user_id::text, m.role_id::text, m.removed_at FROM bricx.memberships m WHERE m.org_id = $1",
      [ORG],
    );
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ user_id: OWNER, removed_at: null });
    const ownerRole = await asAdmin<{ id: string }>(
      "SELECT id::text FROM bricx.roles WHERE org_id = $1 AND system_key = 'owner'",
      [ORG],
    );
    expect(members[0]?.role_id).toBe(ownerRole[0]?.id);
    expect(run.output).toBe(
      `membership:bootstrap: org ${ORG}: owner ${OWNER}, membership ${members[0]?.id ?? ""}, 12 roles\n`,
    );
    const events = await asAdmin<{
      action: string;
      actor_id: string;
      entity_id: string;
      before: unknown;
      after: unknown;
    }>(
      "SELECT action, actor_id::text, entity_id::text, before, after FROM bricx.audit_events WHERE org_id = $1 ORDER BY seq",
      [ORG],
    );
    expect(events).toEqual([
      {
        action: "org.member.bootstrap",
        actor_id: OWNER,
        entity_id: members[0]?.id,
        before: null,
        after: { userId: OWNER, roleId: ownerRole[0]?.id, roles: 12 },
      },
    ]);
    expect(
      await asAdmin(
        "SELECT payload FROM bricx.outbox WHERE org_id = $1 AND topic = 'users.mfa_check'",
        [ORG],
      ),
    ).toEqual([{ payload: { userId: OWNER } }]);

    const token = await issuer.token({
      sub: `boot-${OWNER}`,
      org_id: ORG,
      exp: Math.floor(Date.now() / 1000) + 3_600,
    });
    const members200 = await app.inject({
      method: "GET",
      url: "/v1/members",
      headers: bearer(token),
    });
    expect(members200.statusCode, members200.body).toBe(200);
    expect(JSON.parse(members200.body)).toMatchObject({
      items: [{ userId: OWNER, mfaRequired: true }],
    });
    const roles200 = await app.inject({
      method: "GET",
      url: "/v1/roles",
      headers: bearer(token),
    });
    expect(roles200.statusCode, roles200.body).toBe(200);
    expect(
      (JSON.parse(roles200.body) as { items: unknown[] }).items,
    ).toHaveLength(12);
  });

  test("an org with a membership row (even a removed one) is refused: exit 1, nothing written", async () => {
    const again = await runBootstrap(["--org", ORG, "--user", OTHER]);
    expect(again).toEqual({
      code: 1,
      output: `membership:bootstrap: org ${ORG}: org_not_empty\n`,
    });
    await asAdmin(
      "UPDATE bricx.memberships SET removed_at = now() WHERE org_id = $1",
      [ORG],
    );
    expect(await runBootstrap(["--org", ORG, "--user", OTHER])).toEqual({
      code: 1,
      output: `membership:bootstrap: org ${ORG}: org_not_empty\n`,
    });
    expect(
      await asAdmin(
        "SELECT count(*)::int AS n FROM bricx.roles WHERE org_id = $1",
        [ORG],
      ),
    ).toEqual([{ n: 12 }]);
  });

  test("an unknown user is exit 1 user_missing; a rolled-back transaction leaves no role", async () => {
    const missing = "0199e1a0-0000-7000-8000-0000000000d9";
    expect(await runBootstrap(["--org", OTHER_ORG, "--user", missing])).toEqual(
      {
        code: 1,
        output: `membership:bootstrap: org ${OTHER_ORG}: user_missing\n`,
      },
    );
    expect(
      await asAdmin(
        "SELECT count(*)::int AS n FROM bricx.roles WHERE org_id = $1",
        [OTHER_ORG],
      ),
    ).toEqual([{ n: 0 }]);
  });

  test.each([
    [[]],
    [["--org", ORG]],
    [["--org", "nope", "--user", OWNER]],
    [["--org", ORG, "--user", "nope"]],
    [["--user", OWNER, "--org", ORG]],
    [["--org", ORG, "--user", OWNER, "extra"]],
  ])("usage %j exits 2", async (args) => {
    expect(await runBootstrap(args)).toEqual({
      code: 2,
      output:
        "membership:bootstrap: usage: membership:bootstrap --org <uuid> --user <users.id>\n",
    });
  });

  test("a bad DATABASE_URL exits 2 naming the key only", async () => {
    const run = await runBootstrap(
      ["--org", OTHER_ORG, "--user", OTHER],
      apiEnv({ DATABASE_URL: "nope" }),
    );
    expect(run.code).toBe(2);
    expect(run.output).toContain("DATABASE_URL");
    expect(run.output).not.toContain("nope");
  });
});
