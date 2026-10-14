// Bounds before parsing (design constraint 6; P3 standing rule): an
// oversized input is rejected before any element is read. The tests count
// the work done (element reads through a Proxy), never milliseconds.
import { describe, expect, it } from "vitest";
import { buildAbility, can } from "../src/ability.ts";
import { LIMITS } from "../src/limits.ts";
import { checkSod } from "../src/sod.ts";
import { CONTEXT, IN_SCOPE, PROJECT_1, USER, uuid } from "./helpers.ts";

/** An array of `length` copies of `item` that counts index reads. */
function counted<T>(length: number, item: T) {
  const reads = { count: 0 };
  const target: T[] = Array.from({ length }, () => item);
  const proxy = new Proxy(target, {
    get(t, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads.count += 1;
      return Reflect.get(t, key, receiver) as unknown;
    },
  });
  return { proxy, reads };
}

describe("limits", () => {
  it("are the approved values", () => {
    expect(LIMITS).toEqual({
      grants: 1_000,
      targetsPerGrant: 1_000,
      targetsTotal: 10_000,
      sodHistory: 1_000,
      permissionName: 64,
      objectKeys: 8,
    });
  });
});

describe("buildAbility", () => {
  it("accepts exactly LIMITS.grants grants and rejects one more without reading any", () => {
    const grant = { permission: "field.photo.read", scope: "org" } as const;
    expect(() =>
      buildAbility(
        Array.from({ length: LIMITS.grants }, () => grant),
        CONTEXT,
      ),
    ).not.toThrow();
    const { proxy, reads } = counted(LIMITS.grants + 1, grant);
    expect(() => buildAbility(proxy, CONTEXT)).toThrow(
      expect.objectContaining({ code: "too_many_grants" }),
    );
    expect(reads.count).toBe(0);
  });

  it("rejects a grant with too many targets before reading them", () => {
    const { proxy, reads } = counted(LIMITS.targetsPerGrant + 1, PROJECT_1);
    expect(() =>
      buildAbility(
        [
          {
            permission: "field.photo.read",
            scope: "project",
            projectIds: proxy,
          },
        ],
        CONTEXT,
      ),
    ).toThrow(expect.objectContaining({ code: "too_many_targets" }));
    expect(reads.count).toBe(0);
  });

  it("rejects more than LIMITS.targetsTotal targets in total before reading the grant that passes it", () => {
    const full = Array.from({ length: LIMITS.targetsPerGrant }, (_, i) =>
      uuid(5000 + i),
    );
    const grants = Array.from(
      { length: LIMITS.targetsTotal / LIMITS.targetsPerGrant },
      () => ({
        permission: "field.photo.read" as const,
        scope: "project" as const,
        projectIds: full as never,
      }),
    );
    expect(() => buildAbility(grants, CONTEXT)).not.toThrow();
    const { proxy, reads } = counted(1, PROJECT_1);
    expect(() =>
      buildAbility(
        [
          ...grants,
          {
            permission: "field.photo.read",
            scope: "project",
            projectIds: proxy,
          },
        ],
        CONTEXT,
      ),
    ).toThrow(expect.objectContaining({ code: "too_many_targets" }));
    expect(reads.count).toBe(0);
  });

  it("rejects a long permission name before looking it up, and a grant object with too many keys", () => {
    expect(() =>
      buildAbility(
        [
          {
            permission: "a".repeat(LIMITS.permissionName + 1),
            scope: "org",
          } as never,
        ],
        CONTEXT,
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_grants" }));
    const wide = Object.fromEntries(
      Array.from({ length: LIMITS.objectKeys + 1 }, (_, i) => [
        `k${String(i)}`,
        i,
      ]),
    );
    expect(() => buildAbility([wide as never], CONTEXT)).toThrow(
      expect.objectContaining({ code: "invalid_grants" }),
    );
  });
});

describe("can", () => {
  it("rejects a record object with too many keys", () => {
    const ability = buildAbility([], CONTEXT);
    const wide = {
      ...IN_SCOPE,
      ...Object.fromEntries(
        Array.from({ length: LIMITS.objectKeys }, (_, i) => [
          `k${String(i)}`,
          i,
        ]),
      ),
    };
    expect(() => can(ability, "read", "field.photo", wide)).toThrow(
      expect.objectContaining({ code: "invalid_record" }),
    );
  });
});

describe("checkSod", () => {
  it("rejects more than LIMITS.sodHistory entries without reading any", () => {
    const entry = {
      chainId: uuid(100),
      recordId: uuid(100),
      recordType: "finance.payment",
      action: "request",
      actorId: USER,
    } as const;
    const { proxy, reads } = counted(LIMITS.sodHistory + 1, entry);
    expect(() =>
      checkSod({
        chainId: uuid(100),
        recordId: uuid(100),
        recordType: "finance.payment",
        action: "approve",
        actorId: USER,
        history: proxy,
      }),
    ).toThrow(expect.objectContaining({ code: "too_many_history" }));
    expect(reads.count).toBe(0);
  });
});
