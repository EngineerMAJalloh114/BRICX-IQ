// Errors carry codes only (P3 rule 9; design constraint 6) and every code,
// and a plain denial, maps to an i18n key that exists in en, fr and ar
// (design constraint 7).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAbility, can } from "../src/ability.ts";
import {
  DENIED_KEY,
  PERMISSION_ERROR_CODES,
  PERMISSION_ERROR_KEYS,
  PermissionError,
  SOD_VIOLATION_KEY,
} from "../src/errors.ts";
import { checkSod } from "../src/sod.ts";
import { CONTEXT } from "./helpers.ts";

const SECRET = "sk_live_SECRET-0190a000-input";

const catalog = (locale: string) =>
  JSON.parse(
    readFileSync(
      path.join(
        import.meta.dirname,
        "../node_modules/@bricx/i18n/locales",
        locale,
        "errors.json",
      ),
      "utf8",
    ),
  ) as Record<string, string>;

describe("PermissionError", () => {
  it("has a fixed message per code and no cause", () => {
    for (const code of PERMISSION_ERROR_CODES) {
      const error = new PermissionError(code);
      expect(error.code).toBe(code);
      expect(error.name).toBe("PermissionError");
      expect(error.message).toMatch(/^[a-z][a-z ,.()-]+$/);
      expect(error.cause).toBeUndefined();
      expect(error.key).toBe(PERMISSION_ERROR_KEYS[code]);
    }
  });

  it("never carries input values", () => {
    const attempts: (() => unknown)[] = [
      () =>
        buildAbility([{ permission: SECRET, scope: "org" }] as never, CONTEXT),
      () =>
        buildAbility(
          [{ permission: "field.photo.read", scope: SECRET }] as never,
          CONTEXT,
        ),
      () =>
        buildAbility(
          [
            {
              permission: "field.photo.read",
              scope: "project",
              projectIds: [SECRET],
            },
          ] as never,
          CONTEXT,
        ),
      () => buildAbility([], { orgId: SECRET, userId: SECRET } as never),
      () =>
        can(buildAbility([], CONTEXT), "read", "field.photo", {
          orgId: SECRET,
        }),
      () =>
        can(buildAbility([], CONTEXT), SECRET as never, "field.photo", {
          orgId: SECRET,
        }),
      () => checkSod({ actorId: SECRET } as never),
    ];
    for (const attempt of attempts) {
      let caught: unknown;
      try {
        attempt();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PermissionError);
      const text =
        JSON.stringify(caught) +
        String(caught) +
        ((caught as Error).stack ?? "");
      expect(text).not.toContain("SECRET");
      expect(text).not.toContain("0190a000");
    }
  });
});

describe("i18n keys", () => {
  it("a denial uses errors:forbidden; an SoD violation errors:permission.sod_violation", () => {
    expect(DENIED_KEY).toBe("errors:forbidden");
    expect(SOD_VIOLATION_KEY).toBe("errors:permission.sod_violation");
  });

  it("every error code maps to errors:forbidden (fail closed, no detail to the user)", () => {
    for (const code of PERMISSION_ERROR_CODES) {
      expect(PERMISSION_ERROR_KEYS[code]).toBe("errors:forbidden");
    }
  });

  it.each(["en", "fr", "ar"])(
    "%s has every key this package uses, non-empty",
    (locale) => {
      const messages = catalog(locale);
      for (const key of [
        DENIED_KEY,
        SOD_VIOLATION_KEY,
        ...Object.values(PERMISSION_ERROR_KEYS),
      ]) {
        const name = key.slice("errors:".length);
        expect(messages[name], `${locale} ${key}`).toMatch(/\S/);
      }
    },
  );
});
