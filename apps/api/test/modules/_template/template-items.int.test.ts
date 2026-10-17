// TemplateItems end to end (P4-09, ADR 0059; pnpm new-module copies it
// with the module), against compose.yml's Postgres with the production
// journal, as bricx_app through the real app. Proves: POST is
// @Idempotent() (a replay is byte-equal and writes nothing); a unique
// violation (SQLSTATE 23505) is 409 request.conflict with no row, no
// audit event, no outbox row and no idempotency key, and a retry with the
// same key runs again (owner condition 4); GET one is 404 outside the
// caller's org; the list pages with a cursor; RLS keeps each org to its
// own rows; an identity without the permission is 403 and without an
// identity 401 (owner condition 5).
// new-module:template-only:start
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { enableTenantRls } from "@bricx/db/rls";
import { z } from "zod";
import { TemplateItemsController } from "../../../src/modules/_template/template-items.controller.js";
import { TemplateItemsRepository } from "../../../src/modules/_template/template-items.repository.js";
import { TemplateItemsService } from "../../../src/modules/_template/template-items.service.js";
// new-module:template-only:end
import { loadApiConfig } from "@bricx/config/api";
import {
  type BootstrappedPostgres,
  appDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { type Database, openDatabase, sqlstateOf } from "@bricx/db/database";
import { migrate } from "@bricx/db/migrate";
import { ErrorEnvelopeSchema } from "@bricx/validation/error-envelope";
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../../../src/app.js";
import { setIdentity } from "../../../src/common/db/request-context.js";
import {
  IDEMPOTENCY_KEY_HEADER,
  REPLAYED_HEADER,
} from "../../../src/common/idempotency/decorator.js";
import {
  TemplateItem,
  TemplateItemPage,
} from "../../../src/modules/_template/template-items.dto.js";
import { apiEnv } from "../../env.js";
import { CREATOR, ORG_READER, READ_ONLY } from "./template-items.roles.js";
import { fakeProbes } from "../../probes.js";

const TABLE = "bricx.template_items";
const ROUTE = "/v1/template-items";

const party = (n: string) => ({
  org: `0199e1a0-0000-7000-8000-0000000000${n}1`,
  user: `0199e1a0-0000-7000-8000-0000000000${n}2`,
  project: `0199e1a0-0000-7000-8000-0000000000${n}3`,
  otherProject: `0199e1a0-0000-7000-8000-0000000000${n}4`,
});
const A = party("a");
const B = party("b");

let idCounter = 0;
/** A fresh UUIDv7 (the device generates ids, CLAUDE.md rule 6). */
const newId = () => {
  idCounter += 1;
  return `0199e1a1-0000-7000-8000-${idCounter.toString(16).padStart(12, "0")}`;
};
let keyCounter = 0;
const newKey = () => {
  keyCounter += 1;
  return `template-items-key-${String(keyCounter)}`;
};

/** Stands in for P5's auth guard: the identity from test headers. */
@Injectable()
class TestIdentityGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const headers = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>().headers;
    const org = headers["x-test-org"];
    if (org !== undefined) {
      const list = (name: string) =>
        (headers[name] ?? "").split(",").filter((v) => v !== "");
      setIdentity({
        orgId: org,
        userId: headers["x-test-user"] ?? "",
        projectIds: list("x-test-projects"),
        roles: list("x-test-roles"),
      });
    }
    return true;
  }
}

interface As {
  readonly org: string;
  readonly user: string;
  readonly projects: readonly string[];
  readonly roles: readonly string[];
}
const manager = (p: typeof A): As => ({
  org: p.org,
  user: p.user,
  projects: [p.project],
  roles: [CREATOR],
});

let pg18: BootstrappedPostgres;
let app: NestFastifyApplication;
let database: Database;

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

// new-module:template-only:start
/**
 * The template ships no migration (it is not registered in AppModule), so
 * its table is made here by the same generator a copy's migration comes
 * from: drizzle-kit generate over the schema file, then enableTenantRls()
 * (pnpm db:rls), applied by the real migrator after the production
 * journal. A copy's table is in the production journal instead.
 */
const JournalSchema = z.looseObject({
  entries: z.array(
    z.looseObject({ idx: z.number(), when: z.number(), version: z.string() }),
  ),
});

async function templateMigrationDir(): Promise<string> {
  const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
  const dbDir = path.join(repoRoot, "packages/db");
  const work = await mkdtemp(path.join(os.tmpdir(), "bricx-template-items-"));
  await symlink(
    path.join(dbDir, "node_modules"),
    path.join(work, "node_modules"),
  );
  await writeFile(path.join(work, "package.json"), '{ "type": "module" }\n');
  const schemaFile = path.resolve(
    import.meta.dirname,
    "../../../src/modules/_template/template-items.schema.ts",
  );
  await writeFile(
    path.join(work, "schema.ts"),
    `export { templateItems } from ${JSON.stringify(schemaFile)};\n`,
  );
  await writeFile(
    path.join(work, "drizzle.config.ts"),
    `import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "postgresql", schema: "./schema.ts", out: "./out", schemaFilter: ["bricx"], strict: true });
`,
  );
  execFileSync(
    process.execPath,
    [
      path.join(dbDir, "node_modules/drizzle-kit/bin.cjs"),
      "generate",
      "--name",
      "template_items",
    ],
    { cwd: work, encoding: "utf8" },
  );
  const out = path.join(work, "out");
  const [file] = (await readdir(out)).filter((f) => f.endsWith(".sql"));
  if (file === undefined) throw new Error("drizzle-kit wrote no migration");
  // The production journal first (it creates app.current_org() and the
  // other tables), then the template's migration as the next one.
  const dir = path.join(work, "migrations");
  execFileSync("cp", [
    "-R",
    path.join(repoRoot, "packages/db/migrations"),
    dir,
  ]);
  const journalFile = path.join(dir, "meta/_journal.json");
  const journal = JournalSchema.parse(
    JSON.parse(await readFile(journalFile, "utf8")),
  );
  const last = journal.entries.at(-1);
  const idx = (last?.idx ?? -1) + 1;
  const tag = `${String(idx).padStart(4, "0")}_template_items`;
  journal.entries.push({
    idx,
    version: last?.version ?? "7",
    when: (last?.when ?? 0) + 1,
    tag,
    breakpoints: true,
  });
  await writeFile(journalFile, `${JSON.stringify(journal, null, 2)}\n`);
  await writeFile(
    path.join(dir, `${tag}.sql`),
    `${await readFile(path.join(out, file), "utf8")}\n--> statement-breakpoint\n${enableTenantRls(TABLE, "project.milestone")}\n`,
  );
  return dir;
}
// new-module:template-only:end

beforeAll(async () => {
  pg18 = await startPostgres();
  const owner = { reveal: () => urlFor("bricx_owner", "BRICX_OWNER_PASSWORD") };
  // new-module:template-only:start
  await migrate(owner, await templateMigrationDir());
  // new-module:template-only:end
  // new-module:copy-only: await migrate(owner);
  const url = urlFor("bricx_app", "BRICX_APP_PASSWORD");
  database = openDatabase({ reveal: () => url });
  app = await createApp(loadApiConfig(apiEnv({ DATABASE_URL: url })), {
    probes: fakeProbes(),
    // new-module:template-only:start
    extraControllers: [TemplateItemsController],
    extraProviders: [
      TemplateItemsService,
      TemplateItemsRepository,
      { provide: APP_GUARD, useClass: TestIdentityGuard },
    ],
    // new-module:template-only:end
    // new-module:copy-only: extraProviders: [{ provide: APP_GUARD, useClass: TestIdentityGuard }],
  });
  await app.init();
});
afterAll(async () => {
  await app.close().catch(() => undefined);
  await database.close().catch(() => undefined);
  await pg18.container.stop();
});

function headersFor(as: As | undefined, key: string | null = null) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (as !== undefined) {
    headers["x-test-org"] = as.org;
    headers["x-test-user"] = as.user;
    headers["x-test-projects"] = as.projects.join(",");
    headers["x-test-roles"] = as.roles.join(",");
  }
  if (key !== null) headers[IDEMPOTENCY_KEY_HEADER] = key;
  return headers;
}

const create = (
  as: As | undefined,
  body: unknown,
  key: string | null = newKey(),
) =>
  app.inject({
    method: "POST",
    url: ROUTE,
    headers: headersFor(as, key),
    payload: JSON.stringify(body),
  });

const get = (as: As | undefined, url: string) =>
  app.inject({ method: "GET", url, headers: headersFor(as) });

function expectProblem(
  res: { statusCode: number; headers: Record<string, unknown>; body: string },
  status: number,
  code: string,
) {
  expect(res.statusCode).toBe(status);
  expect(String(res.headers["content-type"])).toContain(
    "application/problem+json",
  );
  const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(res.body));
  expect(parsed.success).toBe(true);
  expect(parsed.data).toMatchObject({ status, code, key: `errors:${code}` });
}

/** What the request wrote for `id` and `key`, read as the test superuser. */
async function writes(id: string, key: string) {
  const [row] = await asAdmin<{
    items: number;
    audit: number;
    outbox: number;
    keys: number;
  }>(
    `SELECT (SELECT count(*)::int FROM ${TABLE} WHERE id = $1) AS items,
            (SELECT count(*)::int FROM bricx.audit_events WHERE entity_id = $1) AS audit,
            (SELECT count(*)::int FROM bricx.outbox WHERE payload->>'id' = $1::text) AS outbox,
            (SELECT count(*)::int FROM bricx.idempotency_keys WHERE key = $2) AS keys`,
    [id, key],
  );
  return row;
}

describe("POST (create): @Idempotent(), @ZodResponse, audit and outbox in one transaction", () => {
  test("201 with the item; one row, one audit event, one outbox row, one key", async () => {
    const id = newId();
    const key = newKey();
    const res = await create(
      manager(A),
      { id, projectId: A.project, name: "Slab poured" },
      key,
    );
    expect(res.statusCode).toBe(201);
    const body = TemplateItem.schema.parse(JSON.parse(res.body));
    expect(body).toMatchObject({
      id,
      projectId: A.project,
      name: "Slab poured",
      createdBy: A.user,
      version: 1,
    });
    expect(Object.keys(body).sort()).toEqual([
      "createdAt",
      "createdBy",
      "id",
      "name",
      "projectId",
      "updatedAt",
      "version",
    ]);
    expect(body.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    expect(await writes(id, key)).toEqual({
      items: 1,
      audit: 1,
      outbox: 1,
      keys: 1,
    });
    const [audit] = await asAdmin<{
      action: string;
      entity_type: string;
      actor_id: string;
      org_id: string;
    }>(
      "SELECT action, entity_type, actor_id::text, org_id::text FROM bricx.audit_events WHERE entity_id = $1",
      [id],
    );
    expect(audit).toEqual({
      action: "project.milestone.create",
      entity_type: "project.milestone",
      actor_id: A.user,
      org_id: A.org,
    });
    const [outbox] = await asAdmin<{
      topic: string;
      payload: unknown;
      org_id: string;
    }>(
      "SELECT topic, payload, org_id::text FROM bricx.outbox WHERE payload->>'id' = $1",
      [id],
    );
    expect(outbox).toEqual({
      topic: "template_items.created",
      payload: { id, projectId: A.project },
      org_id: A.org,
    });
  });

  test("a replay with the same key and body is byte-equal and writes nothing more", async () => {
    const id = newId();
    const key = newKey();
    const body = { id, projectId: A.project, name: "Formwork" };
    const first = await create(manager(A), body, key);
    const replay = await create(manager(A), body, key);
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.body).toBe(first.body);
    expect(replay.headers[REPLAYED_HEADER]).toBe("true");
    expect(first.headers).not.toHaveProperty(REPLAYED_HEADER);
    expect(await writes(id, key)).toEqual({
      items: 1,
      audit: 1,
      outbox: 1,
      keys: 1,
    });
  });

  test("without an Idempotency-Key: 400 idempotency.key_missing, nothing written", async () => {
    const id = newId();
    const res = await create(
      manager(A),
      { id, projectId: A.project, name: "No key" },
      null,
    );
    expectProblem(res, 400, "idempotency.key_missing");
    expect(await writes(id, "none")).toEqual({
      items: 0,
      audit: 0,
      outbox: 0,
      keys: 0,
    });
  });

  test("an invalid body: 422 validation_failed, nothing written", async () => {
    const id = newId();
    const res = await create(manager(A), {
      id,
      projectId: A.project,
      name: "",
    });
    expectProblem(res, 422, "validation_failed");
    expect(await writes(id, "none")).toEqual({
      items: 0,
      audit: 0,
      outbox: 0,
      keys: 0,
    });
  });
});

describe("SQLSTATE 23505 → 409 request.conflict (owner condition 4)", () => {
  test.each([
    [
      "the same name in the same project",
      (first: string) => ({ id: newId(), name: first }),
    ],
    [
      "the same id",
      (_first: string, firstId: string) => ({
        id: firstId,
        name: "Another name",
      }),
    ],
  ])(
    "%s: 409, and no row, audit event, outbox row or idempotency key; the same key and body retried runs again and is 409 again",
    async (_what, conflicting) => {
      const firstId = newId();
      const name = `Roof ${firstId}`;
      expect(
        (await create(manager(A), { id: firstId, projectId: A.project, name }))
          .statusCode,
      ).toBe(201);
      const second = conflicting(name, firstId);
      const body = { ...second, projectId: A.project };
      const key = newKey();
      const before = await writes(second.id, key);
      const res = await create(manager(A), body, key);
      expectProblem(res, 409, "request.conflict");
      expect(await writes(second.id, key)).toEqual({ ...before, keys: 0 });
      const [counts] = await asAdmin<{ audit: number; outbox: number }>(
        `SELECT (SELECT count(*)::int FROM bricx.audit_events) AS audit,
                (SELECT count(*)::int FROM bricx.outbox) AS outbox`,
      );
      const retry = await create(manager(A), body, key);
      expectProblem(retry, 409, "request.conflict");
      expect(retry.headers).not.toHaveProperty(REPLAYED_HEADER);
      expect(await writes(second.id, key)).toEqual({ ...before, keys: 0 });
      expect(
        await asAdmin(
          `SELECT (SELECT count(*)::int FROM bricx.audit_events) AS audit,
                  (SELECT count(*)::int FROM bricx.outbox) AS outbox`,
        ),
      ).toEqual([counts]);
    },
  );

  test("the same name in another project is not a conflict", async () => {
    const name = `Columns ${newId()}`;
    const other: As = { ...manager(A), projects: [A.project, A.otherProject] };
    expect(
      (await create(other, { id: newId(), projectId: A.project, name }))
        .statusCode,
    ).toBe(201);
    expect(
      (await create(other, { id: newId(), projectId: A.otherProject, name }))
        .statusCode,
    ).toBe(201);
  });
});

describe("GET one and the list", () => {
  test("GET one returns the item; an unknown id is 404 not_found", async () => {
    const id = newId();
    const created = await create(manager(A), {
      id,
      projectId: A.project,
      name: "Beams",
    });
    const res = await get(manager(A), `${ROUTE}/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(created.body);
    expectProblem(
      await get(manager(A), `${ROUTE}/${newId()}`),
      404,
      "not_found",
    );
    expectProblem(
      await get(manager(A), `${ROUTE}/not-a-uuid`),
      422,
      "validation_failed",
    );
  });

  test("the list pages by cursor, in id order, within one project", async () => {
    const as: As = { ...manager(A), projects: [A.otherProject] };
    const ids = [newId(), newId(), newId()];
    for (const id of ids) {
      expect(
        (
          await create(as, {
            id,
            projectId: A.otherProject,
            name: `Page ${id}`,
          })
        ).statusCode,
      ).toBe(201);
    }
    const first = await get(as, `${ROUTE}?projectId=${A.otherProject}&limit=2`);
    expect(first.statusCode).toBe(200);
    const page1 = TemplateItemPage.schema.parse(JSON.parse(first.body));
    const all: string[] = page1.items.map((i) => i.id);
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    let cursor: string | null = page1.nextCursor;
    while (cursor !== null) {
      const next = await get(
        as,
        `${ROUTE}?projectId=${A.otherProject}&limit=2&cursor=${cursor}`,
      );
      expect(next.statusCode).toBe(200);
      const page = TemplateItemPage.schema.parse(JSON.parse(next.body));
      all.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    }
    expect(all.filter((id) => ids.includes(id))).toEqual(ids);
    expect([...all].sort()).toEqual(all);
    expectProblem(
      await get(as, `${ROUTE}?projectId=${A.otherProject}&cursor=bm9wZQ`),
      422,
      "validation_failed",
    );
  });
});

describe("RLS isolation of bricx.template_items", () => {
  test("org B sees none of org A's rows, through the API and in SQL, and cannot write into org A", async () => {
    const id = newId();
    expect(
      (await create(manager(A), { id, projectId: A.project, name: "Isolated" }))
        .statusCode,
    ).toBe(201);
    // Through the API: B's identity, even with A's project id, gets 404.
    expectProblem(
      await get({ ...manager(B), projects: [A.project] }, `${ROUTE}/${id}`),
      404,
      "not_found",
    );
    const list = await get(
      ORG_READER === undefined
        ? { ...manager(B), projects: [A.project] }
        : { ...manager(B), roles: [ORG_READER], projects: [A.project] },
      `${ROUTE}?projectId=${A.project}`,
    );
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.body)).toEqual({ items: [], nextCursor: null });
    // In SQL, as bricx_app under withTx(): B sees nothing; A sees its row.
    const ctx = (p: typeof A) => ({
      orgId: p.org,
      userId: p.user,
      projectIds: [p.project],
    });
    const visible = (p: typeof A) =>
      database.withTx(
        ctx(p),
        async (tx) =>
          (
            await tx.execute(
              sql`SELECT count(*)::int AS n FROM bricx.template_items WHERE id = ${id}`,
            )
          ).rows,
      );
    expect(await visible(B)).toEqual([{ n: 0 }]);
    expect(await visible(A)).toEqual([{ n: 1 }]);
    // B cannot insert a row into A's org.
    const refused = await database
      .withTx(ctx(B), (tx) =>
        tx.execute(
          sql`INSERT INTO bricx.template_items (id, org_id, project_id, name, created_by) VALUES (${newId()}, ${A.org}, ${A.project}, 'Intruder', ${B.user})`,
        ),
      )
      .then(
        () => "inserted",
        (error: unknown) => sqlstateOf(error),
      );
    expect(refused).toBe("42501");
  });
});

const DENIED: [string, string[]][] = [
  ["no roles", []],
  ["an unknown role", ["superuser"]],
  ["an empty role", [""]],
];
if (READ_ONLY !== undefined) DENIED.push(["a read-only role", [READ_ONLY]]);

describe("authorization (owner condition 5)", () => {
  test.each(DENIED)(
    "%s: 403 forbidden, nothing written",
    async (_what, roles) => {
      const id = newId();
      const key = newKey();
      const as: As = { ...manager(A), roles };
      const res = await create(
        as,
        { id, projectId: A.project, name: `Denied ${id}` },
        key,
      );
      expectProblem(res, 403, "forbidden");
      expect(await writes(id, key)).toEqual({
        items: 0,
        audit: 0,
        outbox: 0,
        keys: 0,
      });
    },
  );

  test("a project the identity does not hold: 403", async () => {
    const res = await create(manager(A), {
      id: newId(),
      projectId: A.otherProject,
      name: "Elsewhere",
    });
    expectProblem(res, 403, "forbidden");
  });

  test("no identity (before P5 every request): 401 session_expired", async () => {
    expectProblem(
      await create(undefined, {
        id: newId(),
        projectId: A.project,
        name: "Anon",
      }),
      401,
      "session_expired",
    );
    expectProblem(
      await get(undefined, `${ROUTE}/${newId()}`),
      401,
      "session_expired",
    );
    expectProblem(
      await get(undefined, `${ROUTE}?projectId=${A.project}`),
      401,
      "session_expired",
    );
  });
});
