// Devices and sessions: unit tests (P5-03, ADR 0063). The boundary
// schemas, the policies over abilityFor(), the services over plain fakes
// (what each call reads, writes, audits and enqueues, and in what order),
// the controllers' delegation and the modules' wiring. The end-to-end
// behaviour on Postgres is in devices-sessions.int.test.ts.
import type { Tx } from "@bricx/db/database";
import { parseAtBoundary } from "@bricx/validation/error-envelope";
import { MODULE_METADATA } from "@nestjs/common/constants.js";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  type Identity,
  runWithRequestContext,
  setIdentity,
} from "../../src/common/db/request-context.js";
import { ApiError } from "../../src/common/errors/api-error.js";
import { REGISTERS_DEVICE } from "../../src/common/auth/registers-device.decorator.js";
import { DevicesController } from "../../src/modules/devices/devices.controller.js";
import {
  DEVICE_NAME_MAX,
  Device,
  DeviceList,
  DeviceParams,
  PLATFORMS,
  RegisterDevice,
} from "../../src/modules/devices/devices.dto.js";
import { DevicesRepository } from "../../src/modules/devices/devices.repository.js";
import {
  DEVICE_ENTITY,
  DevicesService,
} from "../../src/modules/devices/devices.service.js";
import { DevicesModule } from "../../src/modules/devices/public-api.js";
import { SessionsModule } from "../../src/modules/sessions/public-api.js";
import {
  SessionsController,
  UserSessionsController,
} from "../../src/modules/sessions/sessions.controller.js";
import {
  RevokedSessions,
  Session,
  SessionList,
  SessionParams,
  UserSessionsParams,
} from "../../src/modules/sessions/sessions.dto.js";
import { SESSIONS_REVOKED } from "../../src/modules/sessions/sessions.events.js";
import {
  SUBJECT,
  assertCanReadOrg,
  assertCanRevokeOrg,
} from "../../src/modules/sessions/sessions.policies.js";
import {
  type ClosedSession,
  type SessionRow,
  SessionsRepository,
} from "../../src/modules/sessions/sessions.repository.js";
import {
  type AuditRecorder,
  type OutboxWriter,
  SessionsService,
  type TransactionRunner,
} from "../../src/modules/sessions/sessions.service.js";
import { grantsOf } from "../support/auth.js";

const ORG = "0199e1a0-0000-7000-8000-0000000000a1";
const OTHER_ORG = "0199e1a0-0000-7000-8000-0000000000b1";
const USER = "0199e1a0-0000-7000-8000-0000000000a2";
const OTHER_USER = "0199e1a0-0000-7000-8000-0000000000b2";
const SESSION = "0199e1a0-0000-7000-8000-0000000000a6";
const OTHER_SESSION = "0199e1a0-0000-7000-8000-0000000000b6";
const DEVICE = "0199e1a0-0000-7000-8000-0000000000d1";
const T0 = "2026-10-21T10:00:00.000000Z";
const NOW_MS = Date.UTC(2026, 9, 21, 12, 0, 0);
const NOW = new Date(NOW_MS).toISOString();

const who = (
  roles: readonly string[],
  extra: Partial<Identity> = {},
): Identity => ({
  orgId: ORG,
  userId: USER,
  projectIds: [],
  sessionId: SESSION,
  deviceId: undefined,
  grants: grantsOf({ roles }),
  ...extra,
});

const issuesOf = (dto: { readonly schema: z.ZodType }, input: unknown) => {
  const result = parseAtBoundary(dto.schema, input);
  return result.success
    ? []
    : (result.envelope.issues ?? []).map(
        (i) => `${i.path.join(".")}:${i.code}`,
      );
};

describe("the boundary schemas", () => {
  const body = { id: DEVICE, platform: "android", name: "Site phone" };

  it("a register body: a UUIDv7 id, a platform of the table's enum, a name 1 to DEVICE_NAME_MAX characters, nothing else", () => {
    expect(PLATFORMS).toEqual(["ios", "android", "web"]);
    expect(issuesOf(RegisterDevice, body)).toEqual([]);
    expect(
      issuesOf(RegisterDevice, { ...body, name: "x".repeat(DEVICE_NAME_MAX) }),
    ).toEqual([]);
    expect(
      issuesOf(RegisterDevice, {
        ...body,
        name: "x".repeat(DEVICE_NAME_MAX + 1),
      }),
    ).toEqual(["name:too_large"]);
    expect(issuesOf(RegisterDevice, { ...body, name: "" })).toEqual([
      "name:required",
    ]);
    expect(issuesOf(RegisterDevice, { ...body, platform: "tv" })).toEqual([
      "platform:invalid_value",
    ]);
    expect(
      issuesOf(RegisterDevice, { ...body, id: DEVICE.toUpperCase() }),
    ).toEqual(["id:invalid_value"]);
    expect(issuesOf(RegisterDevice, { ...body, trusted: true })).toEqual([
      ":unknown_field",
    ]);
    expect(issuesOf(RegisterDevice, {})).toEqual([
      "id:required",
      "platform:required",
      "name:required",
    ]);
  });

  it("path ids are UUIDv7", () => {
    expect(issuesOf(DeviceParams, { id: DEVICE })).toEqual([]);
    expect(issuesOf(DeviceParams, { id: "1" })).toEqual(["id:invalid_value"]);
    expect(issuesOf(SessionParams, { id: SESSION })).toEqual([]);
    expect(issuesOf(UserSessionsParams, { userId: USER })).toEqual([]);
    expect(issuesOf(UserSessionsParams, { userId: "me" })).toEqual([
      "userId:invalid_value",
    ]);
  });

  it("the response schemas are strict and never carry the Keycloak session id", () => {
    const device = {
      ...body,
      createdAt: T0,
      lastSeenAt: T0,
      trusted: false,
      revokedAt: null,
    };
    expect(issuesOf(Device, device)).toEqual([]);
    expect(issuesOf(Device, { ...device, userId: USER })).toEqual([
      ":unknown_field",
    ]);
    expect(issuesOf(DeviceList, { items: [device] })).toEqual([]);
    const session = {
      id: SESSION,
      orgId: ORG,
      userId: USER,
      deviceId: null,
      createdAt: T0,
      lastSeenAt: T0,
      revokedAt: null,
      current: true,
    };
    expect(issuesOf(Session, session)).toEqual([]);
    expect(issuesOf(Session, { ...session, keycloakSid: "x" })).toEqual([
      ":unknown_field",
    ]);
    expect(issuesOf(SessionList, { items: [session] })).toEqual([]);
    expect(issuesOf(RevokedSessions, { revoked: [SESSION] })).toEqual([]);
    expect(issuesOf(RevokedSessions, { revoked: ["x"] })).toEqual([
      "revoked.0:invalid_value",
    ]);
  });
});

describe("the policies (owner conditions 1 and 3)", () => {
  it("the subject is the P5-03 catalogue resource", () => {
    expect(SUBJECT).toBe("org.session");
  });

  it("read: owner and auditor may; no grants (production until P5-05) and a project role may not", () => {
    for (const roles of [["owner"], ["auditor"]]) {
      expect(() => {
        assertCanReadOrg(who(roles));
      }).not.toThrow();
    }
    for (const roles of [[], ["project_manager"], ["unknown"]]) {
      expect(() => {
        assertCanReadOrg(who(roles));
      }).toThrow(expect.objectContaining({ code: "forbidden" }));
    }
  });

  it("revoke: the owner may; the auditor (read only) and no grants may not", () => {
    expect(() => {
      assertCanRevokeOrg(who(["owner"]));
    }).not.toThrow();
    for (const roles of [[], ["auditor"], ["project_manager"]]) {
      expect(() => {
        assertCanRevokeOrg(who(roles));
      }).toThrow(ApiError);
    }
  });

  it("the grant is pinned to the identity's org: an identity in another org with the same bundle is refused for this org's check only through its own org", () => {
    // abilityFor() pins every grant to identity.orgId, so the check is
    // always against the request's org: there is no cross-org ability.
    const elsewhere = who(["owner"], { orgId: OTHER_ORG });
    expect(() => {
      assertCanReadOrg(elsewhere);
    }).not.toThrow();
    expect(grantsOf({ roles: ["owner"] }).every((g) => g.scope === "org")).toBe(
      true,
    );
  });
});

/** The services over fakes: one transaction, recorded writes. */
interface Writes {
  readonly audit: {
    action: string;
    entityType: string;
    entityId: string | undefined;
    after: unknown;
  }[];
  readonly outbox: { topic: string; payload: unknown }[];
  readonly calls: string[];
}
// The fake transaction handle: the fakes never use it (one disclosed
// cast; a drizzle transaction cannot be built without a connection).
const TX = {} as unknown as Tx;

function fakes() {
  const writes: Writes = { audit: [], outbox: [], calls: [] };
  const runner: TransactionRunner = {
    run: (fn) => {
      writes.calls.push("tx");
      return fn(TX);
    },
  };
  const audit: AuditRecorder = {
    record: (_tx, event) => {
      writes.calls.push(`audit:${event.action}`);
      writes.audit.push({
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        after: event.after,
      });
      return Promise.resolve({ id: "x", seq: "1", hash: "h" });
    },
  };
  const outbox: OutboxWriter = {
    enqueue: (_tx, topic, payload) => {
      writes.calls.push(`outbox:${topic}`);
      writes.outbox.push({ topic, payload });
      return Promise.resolve("job");
    },
  };
  const clock = { now: () => NOW_MS };
  return { writes, runner, audit, outbox, clock };
}

const row = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: SESSION,
  orgId: ORG,
  userId: USER,
  deviceId: null,
  createdAt: T0,
  lastSeenAt: T0,
  revokedAt: null,
  ...over,
});
const closed = (over: Partial<ClosedSession> = {}): ClosedSession => ({
  id: SESSION,
  orgId: ORG,
  userId: USER,
  keycloakSid: "sid-1",
  ...over,
});

/** Runs `fn` inside a request whose identity is `identity`. */
const asIdentity = <T>(identity: Identity | undefined, fn: () => Promise<T>) =>
  runWithRequestContext(
    { correlationId: "corr-1", ip: "127.0.0.1", deviceId: identity?.deviceId },
    () => {
      if (identity !== undefined) setIdentity(identity);
      return fn();
    },
  );

function sessionsRepo(
  over: Partial<SessionsRepository> = {},
): SessionsRepository {
  const repo = new SessionsRepository();
  return Object.assign(repo, over);
}

describe("SessionsService", () => {
  it("listMine: the caller's rows, `current` marked; without an identity NoTenantContextError", async () => {
    const f = fakes();
    const seen: string[] = [];
    const service = new SessionsService(
      f.runner,
      sessionsRepo({
        listOfUser: (_tx, userId) => {
          seen.push(userId);
          return Promise.resolve([
            row(),
            row({ id: OTHER_SESSION, orgId: OTHER_ORG }),
          ]);
        },
      }),
      f.audit,
      f.outbox,
      f.clock,
    );
    const items = await asIdentity(who([]), () => service.listMine());
    expect(seen).toEqual([USER]);
    expect(items.map((s) => [s.id, s.current])).toEqual([
      [SESSION, true],
      [OTHER_SESSION, false],
    ]);
    await expect(
      asIdentity(undefined, () => service.listMine()),
    ).rejects.toThrow("the request has no tenant identity");
    expect(f.writes.audit).toEqual([]);
  });

  it("revokeMine: closes the row, one outbox row then the audit event (cause self) in the transaction; already closed is silent; unknown is 404", async () => {
    const f = fakes();
    let exists = true;
    let closes: ClosedSession[] = [closed({ orgId: OTHER_ORG })];
    const service = new SessionsService(
      f.runner,
      sessionsRepo({
        closeOne: (_tx, userId, id, now) => {
          f.writes.calls.push(`close:${userId}:${id}:${now}`);
          return Promise.resolve(closes);
        },
        exists: () => Promise.resolve(exists),
      }),
      f.audit,
      f.outbox,
      f.clock,
    );
    await asIdentity(who([]), () => service.revokeMine(SESSION));
    expect(f.writes.calls).toEqual([
      "tx",
      `close:${USER}:${SESSION}:${NOW}`,
      `outbox:${SESSIONS_REVOKED}`,
      "audit:org.session.revoke",
    ]);
    expect(f.writes.outbox).toEqual([
      {
        topic: SESSIONS_REVOKED,
        payload: {
          sessionId: SESSION,
          userId: USER,
          orgId: OTHER_ORG,
          keycloakSid: "sid-1",
        },
      },
    ]);
    expect(f.writes.audit).toEqual([
      {
        action: "org.session.revoke",
        entityType: "org.session",
        entityId: SESSION,
        after: {
          cause: "self",
          actorSessionId: SESSION,
          sessionId: SESSION,
          sessions: [{ id: SESSION, orgId: OTHER_ORG, userId: USER }],
        },
      },
    ]);
    // Already closed: nothing more written.
    closes = [];
    await asIdentity(who([]), () => service.revokeMine(SESSION));
    expect(f.writes.audit).toHaveLength(1);
    // Not the caller's: 404.
    exists = false;
    await expect(
      asIdentity(who([]), () => service.revokeMine(SESSION)),
    ).rejects.toThrow(expect.objectContaining({ code: "not_found" }));
  });

  it("listOfUser and revokeOfUser: the ability check comes before any database work; the owner's revoke lists this org's rows, one audit event with cause admin, one outbox row per session; nothing closed writes nothing", async () => {
    const f = fakes();
    let toClose: ClosedSession[] = [
      closed({ id: OTHER_SESSION, userId: OTHER_USER }),
      closed({ userId: OTHER_USER }),
    ];
    const service = new SessionsService(
      f.runner,
      sessionsRepo({
        listOfUserInOrg: (_tx, userId, orgId) => {
          f.writes.calls.push(`list:${userId}:${orgId}`);
          return Promise.resolve([
            row({ id: OTHER_SESSION, userId: OTHER_USER }),
          ]);
        },
        closeInOrg: (_tx, userId, orgId) => {
          f.writes.calls.push(`closeInOrg:${userId}:${orgId}`);
          return Promise.resolve(toClose);
        },
      }),
      f.audit,
      f.outbox,
      f.clock,
    );
    await expect(
      asIdentity(who([]), () => service.listOfUser(OTHER_USER)),
    ).rejects.toThrow(ApiError);
    await expect(
      asIdentity(who(["auditor"]), () => service.revokeOfUser(OTHER_USER)),
    ).rejects.toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(f.writes.calls).toEqual([]);
    const items = await asIdentity(who(["auditor"]), () =>
      service.listOfUser(OTHER_USER),
    );
    expect(items).toEqual([
      { ...row({ id: OTHER_SESSION, userId: OTHER_USER }), current: false },
    ]);
    const revoked = await asIdentity(who(["owner"]), () =>
      service.revokeOfUser(OTHER_USER),
    );
    expect(revoked).toEqual([OTHER_SESSION, SESSION]);
    expect(f.writes.calls).toEqual([
      "tx",
      `list:${OTHER_USER}:${ORG}`,
      "tx",
      `closeInOrg:${OTHER_USER}:${ORG}`,
      `outbox:${SESSIONS_REVOKED}`,
      `outbox:${SESSIONS_REVOKED}`,
      "audit:org.session.revoke",
    ]);
    expect(f.writes.audit[0]).toMatchObject({
      entityId: undefined,
      after: {
        cause: "admin",
        userId: OTHER_USER,
        sessions: [
          { id: OTHER_SESSION, orgId: ORG, userId: OTHER_USER },
          { id: SESSION, orgId: ORG, userId: OTHER_USER },
        ],
      },
    });
    toClose = [];
    expect(
      await asIdentity(who(["owner"]), () => service.revokeOfUser(OTHER_USER)),
    ).toEqual([]);
    expect(f.writes.audit).toHaveLength(1);
    expect(f.writes.outbox).toHaveLength(2);
  });

  it("revokeOnDevice (for the devices module): closes in the caller's transaction, audit cause device; bindCurrentSession binds the identity's session", async () => {
    const f = fakes();
    const service = new SessionsService(
      f.runner,
      sessionsRepo({
        closeOnDevice: (_tx, userId, deviceId) => {
          f.writes.calls.push(`closeOnDevice:${userId}:${deviceId}`);
          return Promise.resolve([
            closed(),
            closed({ id: OTHER_SESSION, orgId: OTHER_ORG }),
          ]);
        },
        bindDevice: (_tx, id, deviceId) => {
          f.writes.calls.push(`bind:${id}:${deviceId}`);
          return Promise.resolve(true);
        },
      }),
      f.audit,
      f.outbox,
      f.clock,
    );
    const identity = who([]);
    const out = await service.revokeOnDevice(TX, identity, DEVICE);
    expect(out.map((s) => s.id)).toEqual([SESSION, OTHER_SESSION]);
    expect(f.writes.calls).toEqual([
      `closeOnDevice:${USER}:${DEVICE}`,
      `outbox:${SESSIONS_REVOKED}`,
      `outbox:${SESSIONS_REVOKED}`,
      "audit:org.session.revoke",
    ]);
    expect(f.writes.audit[0]?.after).toMatchObject({
      cause: "device",
      deviceId: DEVICE,
    });
    expect(await service.bindCurrentSession(TX, identity, DEVICE)).toBe(true);
    expect(f.writes.calls.at(-1)).toBe(`bind:${SESSION}:${DEVICE}`);
  });
});

function devicesRepo(over: Partial<DevicesRepository> = {}): DevicesRepository {
  return Object.assign(new DevicesRepository(), over);
}
const device = (over: Partial<Device> = {}): Device => ({
  id: DEVICE,
  platform: "android",
  name: "Site phone",
  createdAt: T0,
  lastSeenAt: T0,
  trusted: false,
  revokedAt: null,
  ...over,
});

describe("DevicesService", () => {
  const input = {
    id: DEVICE,
    platform: "android" as const,
    name: "Site phone",
  };

  it("register: the header must name the body id (400 before any database work); inserts, binds the session, one org.device.register audit event with ids only", async () => {
    const f = fakes();
    const sessions = { bound: [] as string[], revoked: [] as string[] };
    const service = new DevicesService(
      f.runner,
      devicesRepo({
        findById: () => Promise.resolve(undefined),
        insert: (_tx, d) => {
          f.writes.calls.push(`insert:${d.id}:${d.userId}:${d.now}`);
          return Promise.resolve(device());
        },
      }),
      {
        bindCurrentSession: (_tx, identity, id) => {
          sessions.bound.push(`${identity.sessionId}:${id}`);
          return Promise.resolve(true);
        },
        revokeOnDevice: () => Promise.resolve([]),
      },
      f.audit,
      f.clock,
    );
    await expect(
      asIdentity(who([]), () => service.register(input)),
    ).rejects.toThrow(expect.objectContaining({ code: "request.malformed" }));
    await expect(
      asIdentity(who([], { deviceId: OTHER_SESSION }), () =>
        service.register(input),
      ),
    ).rejects.toThrow(expect.objectContaining({ code: "request.malformed" }));
    expect(f.writes.calls).toEqual([]);
    const out = await asIdentity(who([], { deviceId: DEVICE }), () =>
      service.register(input),
    );
    expect(out).toEqual(device());
    expect(sessions.bound).toEqual([`${SESSION}:${DEVICE}`]);
    expect(f.writes.calls).toEqual([
      "tx",
      `insert:${DEVICE}:${USER}:${NOW}`,
      `audit:${DEVICE_ENTITY}.register`,
    ]);
    expect(f.writes.audit).toEqual([
      {
        action: "org.device.register",
        entityType: "org.device",
        entityId: DEVICE,
        after: { userId: USER, sessionId: SESSION },
      },
    ]);
    expect(JSON.stringify(f.writes.audit)).not.toContain("Site phone");
  });

  it("register again: the caller's existing row is returned unchanged (bound, not audited); a revoked one is 409", async () => {
    const f = fakes();
    let existing = device({ name: "Old name" });
    const service = new DevicesService(
      f.runner,
      devicesRepo({
        findById: () => Promise.resolve(existing),
        insert: () => Promise.reject(new Error("must not insert")),
      }),
      {
        bindCurrentSession: () => Promise.resolve(false),
        revokeOnDevice: () => Promise.resolve([]),
      },
      f.audit,
      f.clock,
    );
    const out = await asIdentity(who([], { deviceId: DEVICE }), () =>
      service.register(input),
    );
    expect(out).toEqual(existing);
    expect(f.writes.audit).toEqual([]);
    existing = device({ revokedAt: T0 });
    await expect(
      asIdentity(who([], { deviceId: DEVICE }), () => service.register(input)),
    ).rejects.toThrow(expect.objectContaining({ code: "request.conflict" }));
  });

  it("listMine delegates; revoke closes the device then its sessions then audits org.device.revoke; already revoked is silent; unknown is 404", async () => {
    const f = fakes();
    let revoked = true;
    let found: Device | undefined = device({ revokedAt: T0 });
    const service = new DevicesService(
      f.runner,
      devicesRepo({
        listMine: () => Promise.resolve([device()]),
        revoke: (_tx, id, now) => {
          f.writes.calls.push(`revoke:${id}:${now}`);
          return Promise.resolve(revoked);
        },
        findById: () => Promise.resolve(found),
      }),
      {
        bindCurrentSession: () => Promise.resolve(false),
        revokeOnDevice: (_tx, identity, id) => {
          f.writes.calls.push(`sessions:${identity.userId}:${id}`);
          return Promise.resolve([
            closed(),
            closed({ id: OTHER_SESSION, orgId: OTHER_ORG }),
          ]);
        },
      },
      f.audit,
      f.clock,
    );
    expect(await asIdentity(who([]), () => service.listMine())).toEqual([
      device(),
    ]);
    await asIdentity(who([]), () => service.revoke(DEVICE));
    expect(f.writes.calls).toEqual([
      "tx",
      "tx",
      `revoke:${DEVICE}:${NOW}`,
      `sessions:${USER}:${DEVICE}`,
      `audit:${DEVICE_ENTITY}.revoke`,
    ]);
    expect(f.writes.audit).toEqual([
      {
        action: "org.device.revoke",
        entityType: "org.device",
        entityId: DEVICE,
        after: {
          userId: USER,
          sessions: [
            { id: SESSION, orgId: ORG },
            { id: OTHER_SESSION, orgId: OTHER_ORG },
          ],
        },
      },
    ]);
    revoked = false;
    await asIdentity(who([]), () => service.revoke(DEVICE));
    expect(f.writes.audit).toHaveLength(1);
    found = undefined;
    await expect(
      asIdentity(who([]), () => service.revoke(DEVICE)),
    ).rejects.toThrow(expect.objectContaining({ code: "not_found" }));
  });
});

describe("the controllers only delegate", () => {
  it("devices: register (marked @RegistersDevice()), list, revoke", async () => {
    const calls: unknown[] = [];
    const controller = new DevicesController({
      register: (body) => {
        calls.push(["register", body]);
        return Promise.resolve(device());
      },
      listMine: () => {
        calls.push(["list"]);
        return Promise.resolve([device()]);
      },
      revoke: (id) => {
        calls.push(["revoke", id]);
        return Promise.resolve();
      },
    });
    const body = {
      id: DEVICE,
      platform: "android" as const,
      name: "Site phone",
    };
    expect(await controller.register(body)).toEqual(device());
    expect(await controller.list()).toEqual({ items: [device()] });
    await controller.revoke({ id: DEVICE });
    expect(calls).toEqual([["register", body], ["list"], ["revoke", DEVICE]]);
    // Only register carries the @RegistersDevice() metadata.
    const marked = (name: string): unknown => {
      const handler: unknown = Object.getOwnPropertyDescriptor(
        DevicesController.prototype,
        name,
      )?.value;
      if (typeof handler !== "function") throw new Error(`no handler ${name}`);
      return Reflect.getMetadata(REGISTERS_DEVICE, handler);
    };
    expect(marked("register")).toBe(true);
    expect(marked("list")).toBeUndefined();
    expect(marked("revoke")).toBeUndefined();
  });

  it("sessions: list, revoke; users/:userId/sessions: list, revoke", async () => {
    const calls: unknown[] = [];
    const session = { ...row(), current: true };
    const port = {
      listMine: () => {
        calls.push(["listMine"]);
        return Promise.resolve([session]);
      },
      revokeMine: (id: string) => {
        calls.push(["revokeMine", id]);
        return Promise.resolve();
      },
      listOfUser: (userId: string) => {
        calls.push(["listOfUser", userId]);
        return Promise.resolve([session]);
      },
      revokeOfUser: (userId: string) => {
        calls.push(["revokeOfUser", userId]);
        return Promise.resolve([SESSION]);
      },
    };
    const mine = new SessionsController(port);
    const admin = new UserSessionsController(port);
    expect(await mine.list()).toEqual({ items: [session] });
    await mine.revoke({ id: SESSION });
    expect(await admin.list({ userId: OTHER_USER })).toEqual({
      items: [session],
    });
    expect(await admin.revoke({ userId: OTHER_USER })).toEqual({
      revoked: [SESSION],
    });
    expect(calls).toEqual([
      ["listMine"],
      ["revokeMine", SESSION],
      ["listOfUser", OTHER_USER],
      ["revokeOfUser", OTHER_USER],
    ]);
  });
});

describe("the Nest modules", () => {
  it("sessions holds both controllers, the service and the repository, and exports the service", () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, SessionsModule),
    ).toEqual([SessionsController, UserSessionsController]);
    expect(
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, SessionsModule),
    ).toEqual([SessionsService, SessionsRepository]);
    expect(
      Reflect.getMetadata(MODULE_METADATA.EXPORTS, SessionsModule),
    ).toEqual([SessionsService]);
  });

  it("devices holds the controller, the service and the repository, and imports sessions", () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, DevicesModule),
    ).toEqual([DevicesController]);
    expect(
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, DevicesModule),
    ).toEqual([DevicesService, DevicesRepository]);
    expect(
      Reflect.getMetadata(MODULE_METADATA.IMPORTS, DevicesModule),
    ).toContain(SessionsModule);
  });
});
