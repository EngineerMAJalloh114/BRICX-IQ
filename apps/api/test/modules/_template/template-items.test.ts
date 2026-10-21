// TemplateItems: unit tests (P4-09, ADR 0059; pnpm new-module copies them
// with the module). The boundary schemas, the policies over abilityFor(),
// the outbox payload and the module's wiring. The end-to-end behaviour is
// in template-items.int.test.ts.
import { parseAtBoundary } from "@bricx/validation/error-envelope";
import { MODULE_METADATA } from "@nestjs/common/constants.js";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { Identity } from "../../../src/common/db/request-context.js";
import { ApiError } from "../../../src/common/errors/api-error.js";
import {
  CreateTemplateItem,
  ListTemplateItemsQuery,
  NAME_MAX,
  TemplateItem,
  TemplateItemParams,
  decodeCursor,
  encodeCursor,
} from "../../../src/modules/_template/template-items.dto.js";
import { TemplateItemsController } from "../../../src/modules/_template/template-items.controller.js";
import {
  TEMPLATE_ITEMS_CREATED,
  createdPayload,
} from "../../../src/modules/_template/template-items.events.js";
import { TemplateItemsModule } from "../../../src/modules/_template/public-api.js";
import {
  SUBJECT,
  assertCanCreate,
  canRead,
  readFilters,
} from "../../../src/modules/_template/template-items.policies.js";
import { TemplateItemsRepository } from "../../../src/modules/_template/template-items.repository.js";
import { TemplateItemsService } from "../../../src/modules/_template/template-items.service.js";
import { grantsOf } from "../../support/auth.js";
import { CREATOR, READ_ONLY } from "./template-items.roles.js";

const ORG = "0199e1a0-0000-7000-8000-0000000000a1";
const USER = "0199e1a0-0000-7000-8000-0000000000a2";
const PROJECT = "0199e1a0-0000-7000-8000-0000000000a3";
const OTHER_PROJECT = "0199e1a0-0000-7000-8000-0000000000b3";
const ID = "0199e1a0-0000-7000-8000-0000000000a5";
const SESSION = "0199e1a0-0000-7000-8000-0000000000a6";

/** An identity holding `roles`' bundles over PROJECT (test-only grants, P5-02). */
const who = (roles: readonly string[]): Identity => ({
  orgId: ORG,
  userId: USER,
  projectIds: [PROJECT],
  sessionId: SESSION,
  deviceId: undefined,
  grants: grantsOf({ projects: [PROJECT], roles }),
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
  const body = { id: ID, projectId: PROJECT, name: "Slab poured" };

  it("a create body: id and projectId are UUIDv7, the name 1 to NAME_MAX characters", () => {
    expect(issuesOf(CreateTemplateItem, body)).toEqual([]);
    expect(
      issuesOf(CreateTemplateItem, { ...body, name: "x".repeat(NAME_MAX) }),
    ).toEqual([]);
    expect(
      issuesOf(CreateTemplateItem, { ...body, name: "x".repeat(NAME_MAX + 1) }),
    ).toEqual(["name:too_large"]);
    expect(issuesOf(CreateTemplateItem, { ...body, name: "" })).toEqual([
      "name:required",
    ]);
    expect(
      issuesOf(CreateTemplateItem, {
        ...body,
        id: "0199e1a0-0000-4000-8000-0000000000a5",
      }),
    ).toEqual(["id:invalid_value"]);
    expect(issuesOf(CreateTemplateItem, { ...body, projectId: 7 })).toEqual([
      "projectId:invalid_value",
    ]);
    expect(issuesOf(CreateTemplateItem, { ...body, orgId: ORG })).toEqual([
      ":unknown_field",
    ]);
    expect(issuesOf(CreateTemplateItem, { name: "x" })).toEqual([
      "id:required",
      "projectId:required",
    ]);
  });

  it("a path id is a UUIDv7", () => {
    expect(issuesOf(TemplateItemParams, { id: ID })).toEqual([]);
    expect(issuesOf(TemplateItemParams, { id: "1" })).toEqual([
      "id:invalid_value",
    ]);
  });

  it("a list query: projectId, an optional cursor this module wrote, a limit", () => {
    expect(issuesOf(ListTemplateItemsQuery, { projectId: PROJECT })).toEqual(
      [],
    );
    expect(
      issuesOf(ListTemplateItemsQuery, {
        projectId: PROJECT,
        cursor: encodeCursor(ID),
        limit: "2",
      }),
    ).toEqual([]);
    expect(
      issuesOf(ListTemplateItemsQuery, {
        projectId: PROJECT,
        cursor: "bm9wZQ",
      }),
    ).toEqual(["cursor:invalid_cursor"]);
    expect(
      issuesOf(ListTemplateItemsQuery, { projectId: PROJECT, limit: "0" }),
    ).toEqual(["limit:invalid_page_size"]);
    expect(issuesOf(ListTemplateItemsQuery, {})).toEqual([
      "projectId:required",
    ]);
  });

  it("a cursor round-trips an id; anything else is undefined", () => {
    expect(decodeCursor(encodeCursor(ID))).toBe(ID);
    expect(decodeCursor("bm9wZQ")).toBeUndefined();
    expect(decodeCursor("")).toBeUndefined();
  });

  it("the response schema is strict: no field beyond the item's", () => {
    const item = {
      id: ID,
      projectId: PROJECT,
      name: "Slab poured",
      createdBy: USER,
      createdAt: "2026-10-17T21:00:00.000000Z",
      updatedAt: "2026-10-17T21:00:00.000000Z",
      version: 1,
    };
    expect(issuesOf(TemplateItem, item)).toEqual([]);
    expect(issuesOf(TemplateItem, { ...item, orgId: ORG })).toEqual([
      ":unknown_field",
    ]);
  });
});

describe("the policies (over abilityFor, owner condition 5)", () => {
  const record = { orgId: ORG, projectId: PROJECT, createdBy: USER };

  it("the subject is a catalogue subject", () => {
    expect(SUBJECT).toBe("project.milestone");
  });

  it("create: allowed for the creator role on its project; forbidden otherwise", () => {
    expect(() => {
      assertCanCreate(who([CREATOR]), record);
    }).not.toThrow();
    for (const roles of [
      [],
      ["unknown"],
      ...(READ_ONLY === undefined ? [] : [[READ_ONLY]]),
    ]) {
      expect(() => {
        assertCanCreate(who(roles), record);
      }).toThrow(ApiError);
    }
    expect(() => {
      assertCanCreate(who([CREATOR]), {
        ...record,
        projectId: OTHER_PROJECT,
      });
    }).toThrow(expect.objectContaining({ code: "forbidden" }));
  });

  it("read: one row, and the list filters", () => {
    expect(canRead(who([CREATOR]), record)).toBe(true);
    if (READ_ONLY !== undefined) {
      expect(canRead(who([READ_ONLY]), record)).toBe(true);
    }
    expect(canRead(who([]), record)).toBe(false);
    expect(readFilters(who([]))).toEqual([]);
    const filters = readFilters(who([CREATOR]));
    expect(filters.length).toBeGreaterThan(0);
    for (const filter of filters) expect(filter.orgId).toBe(ORG);
  });
});

describe("the outbox event", () => {
  it("is registered as <module>.created and carries ids only", () => {
    expect(TEMPLATE_ITEMS_CREATED).toBe("template_items.created");
    expect(
      createdPayload({
        id: ID,
        projectId: PROJECT,
        name: "Slab poured",
        createdBy: USER,
        createdAt: "2026-10-17T21:00:00.000000Z",
        updatedAt: "2026-10-17T21:00:00.000000Z",
        version: 1,
      }),
    ).toEqual({ id: ID, projectId: PROJECT });
  });
});

describe("the Nest module", () => {
  it("holds the controller, the service and the repository", () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, TemplateItemsModule),
    ).toEqual([TemplateItemsController]);
    expect(
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, TemplateItemsModule),
    ).toEqual([TemplateItemsService, TemplateItemsRepository]);
  });
});
