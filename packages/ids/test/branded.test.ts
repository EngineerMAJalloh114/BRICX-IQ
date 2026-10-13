// Branded ids: OrgId, UserId, ProjectId, SiteId (P3-01 ruling; the ROADMAP
// names ProjectId and no others). Type tests run under `tsc --noEmit`.
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  isOrgId,
  isProjectId,
  isSiteId,
  isUserId,
  parseOrgId,
  parseProjectId,
  parseSiteId,
  parseUserId,
  safeParseOrgId,
  safeParseProjectId,
  safeParseSiteId,
  safeParseUserId,
  toOrgId,
  toProjectId,
  toSiteId,
  toUserId,
} from "../src/branded.js";
import type { OrgId, ProjectId, SiteId, UserId } from "../src/branded.js";
import type { IdParseResult, UuidV7 } from "../src/uuid-v7.js";
import { IdError, createUuidV7Generator } from "../src/uuid-v7.js";
import { frozenClock, seededRandom } from "./helpers.js";

const VALID = "017f22e2-79b0-7cc3-98c4-dc0c0c07398f";
const V4 = "017f22e2-79b0-4cc3-98c4-dc0c0c07398f";

const kinds = [
  {
    name: "OrgId",
    parse: parseOrgId,
    safe: safeParseOrgId,
    is: isOrgId,
    to: toOrgId,
  },
  {
    name: "UserId",
    parse: parseUserId,
    safe: safeParseUserId,
    is: isUserId,
    to: toUserId,
  },
  {
    name: "ProjectId",
    parse: parseProjectId,
    safe: safeParseProjectId,
    is: isProjectId,
    to: toProjectId,
  },
  {
    name: "SiteId",
    parse: parseSiteId,
    safe: safeParseSiteId,
    is: isSiteId,
    to: toSiteId,
  },
] as const;

describe.each(kinds)("$name", ({ parse, safe, is, to }) => {
  it("parses a valid id to the same string", () => {
    expect(parse(VALID)).toBe(VALID);
    expect(safe(VALID)).toEqual({ ok: true, value: VALID });
    expect(is(VALID)).toBe(true);
  });

  it("applies the same strict rules as parseUuidV7", () => {
    expect(() => parse(V4)).toThrow(IdError);
    expect(() => parse(VALID.toUpperCase())).toThrow(
      expect.objectContaining({ code: "uppercase" }),
    );
    expect(safe(V4)).toEqual({ ok: false, code: "not_v7" });
    expect(is(V4)).toBe(false);
  });

  it("brands a generated id without changing it", () => {
    const id = createUuidV7Generator({
      clock: frozenClock(1),
      fillRandom: seededRandom(1),
    }).next();
    expect(to(id)).toBe(id);
  });
});

describe("types", () => {
  it("each brand is a UuidV7 and a string, but no brand is another", () => {
    expectTypeOf<OrgId>().toExtend<UuidV7>();
    expectTypeOf<OrgId>().toExtend<string>();
    expectTypeOf<OrgId>().not.toExtend<UserId>();
    expectTypeOf<UserId>().not.toExtend<OrgId>();
    expectTypeOf<ProjectId>().not.toExtend<SiteId>();
    expectTypeOf<SiteId>().not.toExtend<ProjectId>();
    expectTypeOf<OrgId>().not.toExtend<ProjectId>();
    expectTypeOf<UserId>().not.toExtend<SiteId>();
  });

  it("a plain string or a plain UuidV7 is not a branded id", () => {
    expectTypeOf<string>().not.toExtend<UuidV7>();
    expectTypeOf<string>().not.toExtend<OrgId>();
    expectTypeOf<UuidV7>().not.toExtend<OrgId>();
  });

  it("parsers return their brand", () => {
    expectTypeOf(parseOrgId).returns.toEqualTypeOf<OrgId>();
    expectTypeOf(parseUserId).returns.toEqualTypeOf<UserId>();
    expectTypeOf(parseProjectId).returns.toEqualTypeOf<ProjectId>();
    expectTypeOf(parseSiteId).returns.toEqualTypeOf<SiteId>();
    expectTypeOf(safeParseOrgId).returns.toEqualTypeOf<IdParseResult<OrgId>>();
    expectTypeOf(toSiteId).parameter(0).toEqualTypeOf<UuidV7>();
  });

  it("is* narrows unknown to the brand", () => {
    const value: unknown = VALID;
    if (isProjectId(value)) expectTypeOf(value).toEqualTypeOf<ProjectId>();
    expect(isProjectId(value)).toBe(true);
  });
});
