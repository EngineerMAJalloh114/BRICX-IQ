// The Valkey revocation store, live (P5-04, ADR 0065; plan decision 6):
// one MGET of the org-scoped keys per check, a revoked sid before a
// revoked user, keys of another org ignored, a key gone when its TTL ends;
// Valkey unreachable or paused is RevocationUnavailable within the 500 ms
// bound and the store recovers once Valkey is back. Then the real guard
// with the real store: a key set in Valkey is 401 session_expired on the
// next request, a paused Valkey is 503 server_unavailable, and both go back
// to 200. The guard's own logic (order, reasons, logging) is in
// revocation-guard.test.ts; the end-to-end revoke with the worker is in
// revocation.int.test.ts.
import { execFile } from "node:child_process";
import { Writable } from "node:stream";
import { promisify } from "node:util";
import { loadApiConfig } from "@bricx/config/api";
import { type StartedValkey, startValkey } from "@bricx/db-bootstrap/stack";
import { Controller, Get } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import {
  REVOCATION_TIMEOUT_MS,
  RevocationUnavailable,
  ValkeyRevocationStore,
  revocationKeys,
} from "../src/common/auth/revocation-store.js";
import { currentRequestContext } from "../src/common/db/request-context.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";
import {
  TestIssuer,
  bearer,
  fixedSessions,
  fixedUsers,
  roleGrants,
  sidFor,
} from "./support/auth.js";

const HOOK_MS = 300_000;
const ORG = "0199e1a0-0000-7000-8000-00000000000a";
const OTHER_ORG = "0199e1a0-0000-7000-8000-00000000000b";
const USER = "0199e1a0-0000-7000-8000-000000000001";
const SUB = "sub-sentinel-7c31-personal";
const SID = "0199e1a0-0000-7000-8000-0000000000e5";

@Controller({ path: "whoami", version: "1" })
class WhoAmIController {
  @Get()
  get() {
    return { identity: currentRequestContext()?.identity ?? null };
  }
}

let valkey: StartedValkey;
let admin: Redis;
let issuer: TestIssuer;
let app: NestFastifyApplication;
const lines: string[] = [];

const secret = (url: string) => ({ reveal: () => url });
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  [valkey, issuer] = await Promise.all([startValkey(), TestIssuer.start()]);
  admin = new Redis(valkey.url(), { maxRetriesPerRequest: 1 });
  admin.on("error", () => undefined);
  app = await createApp(
    loadApiConfig(apiEnv({ ...issuer.env(), VALKEY_URL: valkey.url() })),
    {
      probes: fakeProbes(),
      logStream: new Writable({
        write(chunk: Buffer, _encoding, done) {
          lines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
          done();
        },
      }),
      extraControllers: [WhoAmIController],
      userDirectory: fixedUsers({ [SUB]: USER }, USER),
      sessionTracker: fixedSessions(),
      grantsSource: roleGrants(),
    },
  );
  await app.init();
}, HOOK_MS);

afterAll(async () => {
  await app.close().catch(() => undefined);
  admin.disconnect();
  await issuer.close();
  await valkey.stop();
}, HOOK_MS);

const keys = revocationKeys({ orgId: ORG, userId: USER, keycloakSid: SID });

describe("ValkeyRevocationStore", () => {
  test("no key: undefined; the sid key: revoked_sid; the user key alone: revoked_user; both: revoked_sid; another org's keys: undefined", async () => {
    const store = new ValkeyRevocationStore(secret(valkey.url()));
    try {
      const input = { orgId: ORG, userId: USER, keycloakSid: SID };
      await admin.flushall();
      expect(await store.check(input)).toBeUndefined();
      await admin.set(keys.user, "1", "EX", 60);
      expect(await store.check(input)).toBe("revoked_user");
      await admin.set(keys.sid, "1", "EX", 60);
      expect(await store.check(input)).toBe("revoked_sid");
      await admin.del(keys.user);
      expect(await store.check(input)).toBe("revoked_sid");
      await admin.flushall();
      const other = revocationKeys({ ...input, orgId: OTHER_ORG });
      await admin.set(other.sid, "1", "EX", 60);
      await admin.set(other.user, "1", "EX", 60);
      expect(await store.check(input)).toBeUndefined();
      expect(await store.check({ ...input, orgId: OTHER_ORG })).toBe(
        "revoked_sid",
      );
    } finally {
      await store.close();
      await admin.flushall();
    }
  });

  test("a key is gone when its TTL ends", async () => {
    const store = new ValkeyRevocationStore(secret(valkey.url()));
    try {
      const input = { orgId: ORG, userId: USER, keycloakSid: SID };
      await admin.set(keys.sid, "1", "PX", 400);
      expect(await store.check(input)).toBe("revoked_sid");
      await sleep(600);
      expect(await store.check(input)).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  test("unreachable: RevocationUnavailable inside the 500 ms bound (plus connect), no value in the message", async () => {
    // A port nothing listens on.
    const store = new ValkeyRevocationStore(
      secret("redis://default:nobody-home-1234567890@127.0.0.1:1"),
    );
    try {
      const started = performance.now();
      let thrown: unknown;
      try {
        await store.check({ orgId: ORG, userId: USER, keycloakSid: SID });
      } catch (error) {
        thrown = error;
      }
      const elapsed = performance.now() - started;
      expect(thrown).toBeInstanceOf(RevocationUnavailable);
      expect((thrown as Error).message).not.toContain("127.0.0.1");
      expect((thrown as Error).message).not.toContain("nobody-home");
      expect(elapsed).toBeLessThan(REVOCATION_TIMEOUT_MS * 4);
    } finally {
      await store.close();
    }
  });

  test("paused: RevocationUnavailable within the bound; unpaused: the store answers again (no stuck client)", async () => {
    const store = new ValkeyRevocationStore(secret(valkey.url()));
    const input = { orgId: ORG, userId: USER, keycloakSid: SID };
    try {
      expect(await store.check(input)).toBeUndefined();
      await pause(true);
      try {
        const started = performance.now();
        await expect(store.check(input)).rejects.toBeInstanceOf(
          RevocationUnavailable,
        );
        expect(performance.now() - started).toBeLessThan(
          REVOCATION_TIMEOUT_MS * 4,
        );
      } finally {
        await pause(false);
      }
      await admin.set(keys.user, "1", "EX", 60);
      let answer: string | undefined;
      for (let i = 0; i < 20 && answer === undefined; i += 1) {
        try {
          answer = await store.check(input);
        } catch {
          await sleep(100);
        }
      }
      expect(answer).toBe("revoked_user");
    } finally {
      await store.close();
      await admin.flushall();
    }
  });
});

/** Pauses or unpauses the Valkey container (the daemon stops answering). */
async function pause(on: boolean): Promise<void> {
  await promisify(execFile)("docker", [
    on ? "pause" : "unpause",
    valkey.container.getId(),
  ]);
}

describe("the guard with the real store", () => {
  const whoami = async () =>
    app.inject({
      method: "GET",
      url: "/v1/whoami",
      headers: bearer(await issuer.token({ sub: SUB, org_id: ORG })),
    });

  test("a key set in Valkey is 401 session_expired on the next request; deleted, 200 again; a paused Valkey is 503 server_unavailable, then 200", async () => {
    const mine = revocationKeys({
      orgId: ORG,
      userId: USER,
      keycloakSid: sidFor(SUB),
    });
    expect((await whoami()).statusCode).toBe(200);
    await admin.set(mine.sid, "1", "EX", 60);
    const refused = await whoami();
    expect(refused.statusCode).toBe(401);
    expect(refused.json<{ code: string }>().code).toBe("session_expired");
    await admin.del(mine.sid);
    expect((await whoami()).statusCode).toBe(200);
    await admin.set(mine.user, "1", "EX", 60);
    expect((await whoami()).statusCode).toBe(401);
    await admin.del(mine.user);
    expect((await whoami()).statusCode).toBe(200);

    await pause(true);
    try {
      const down = await whoami();
      expect(down.statusCode).toBe(503);
      expect(down.json<{ code: string }>().code).toBe("server_unavailable");
    } finally {
      await pause(false);
    }
    let status = 0;
    for (let i = 0; i < 20 && status !== 200; i += 1) {
      status = (await whoami()).statusCode;
      if (status !== 200) await sleep(100);
    }
    expect(status).toBe(200);
    const all = lines.join("\n");
    expect(all).toContain("auth.revocation_unavailable");
    expect(all).not.toContain(sidFor(SUB));
    expect(all).not.toContain(SUB);
    expect(all).not.toContain(valkey.url());
  });
});
