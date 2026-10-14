// isRTL (P3-03 ruling, D10): Intl.Locale text info where the engine has it,
// documented tables where it does not (Hermes). The tables are checked
// against Node 24's CLDR, and the fallback path against Intl on a tag table.
import { afterEach, describe, expect, it, vi } from "vitest";
import { isRTL } from "../src/rtl.ts";
import {
  RTL_LANGUAGES,
  RTL_REGION_OVERRIDES,
  RTL_SCRIPTS,
} from "../src/generated/rtl-data.ts";
import {
  SENTINEL,
  expectI18nError,
  intlWith,
  intlWithout,
  timed,
  textDirection,
} from "./helpers.ts";
import { RTL_TAGS, rtlChecks } from "./checks-rtl.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Intl without Intl.Locale, as on Hermes. */
function stubNoIntlLocale(): void {
  vi.stubGlobal("Intl", intlWithout("Locale"));
  expect("Locale" in Intl).toBe(false);
  expect(typeof Intl.getCanonicalLocales).toBe("function");
}

/** Node's own answer: maximize() then getTextInfo(). */
const nodeIsRTL = (tag: string) =>
  textDirection(new Intl.Locale(tag).maximize()) === "rtl";

describe("isRTL with Intl.Locale (Node 24)", () => {
  it("ar is RTL; en and fr are not", () => {
    expect(isRTL("ar")).toBe(true);
    expect(isRTL("en")).toBe(false);
    expect(isRTL("fr")).toBe(false);
  });

  it("passes the shared table", () => {
    rtlChecks(isRTL);
  });

  it.each(["en_US", "e", "-ar", "ar-", "ar--EG", "", " ar"])(
    "a malformed tag %j throws invalid_locale",
    (tag) => {
      expectI18nError(() => isRTL(tag), "invalid_locale");
    },
  );

  it("a non-string throws invalid_locale", () => {
    expectI18nError(() => isRTL(undefined), "invalid_locale");
    expectI18nError(() => isRTL(7), "invalid_locale");
  });

  it("an oversized tag throws locale_too_long quickly and never echoes it", () => {
    const huge = `ar-${SENTINEL}-` + "a".repeat(1_000_000);
    expect(
      timed(() => expectI18nError(() => isRTL(huge), "locale_too_long")),
    ).toBeLessThan(50);
    expectI18nError(() => isRTL(`${SENTINEL}_x`), "invalid_locale");
  });

  it("uses the older textInfo getter when getTextInfo is absent", () => {
    class LegacyLocale {
      readonly textInfo: { direction: string };
      readonly script = "Latn";
      constructor(tag: string) {
        this.textInfo = { direction: tag.startsWith("he") ? "rtl" : "ltr" };
      }
      maximize(): this {
        return this;
      }
    }
    vi.stubGlobal("Intl", intlWith("Locale", LegacyLocale));
    expect(isRTL("he")).toBe(true);
    expect(isRTL("ar")).toBe(false);
  });

  it("uses the script table when Intl.Locale has no text info at all", () => {
    class BareLocale {
      readonly script: string | undefined;
      constructor(tag: string) {
        this.script =
          tag === "ar"
            ? "Arab"
            : tag === "he"
              ? "Hebr"
              : tag === "zz"
                ? undefined
                : "Latn";
      }
      maximize(): this {
        return this;
      }
    }
    vi.stubGlobal("Intl", intlWith("Locale", BareLocale));
    expect(isRTL("ar")).toBe(true);
    expect(isRTL("he")).toBe(true);
    expect(isRTL("fr")).toBe(false);
    expect(isRTL("zz")).toBe(false);
  });
});

describe("isRTL without Intl.Locale (the Hermes fallback)", () => {
  it("ar is RTL; en and fr are not; malformed throws", () => {
    stubNoIntlLocale();
    expect(isRTL("ar")).toBe(true);
    expect(isRTL("en")).toBe(false);
    expect(isRTL("fr")).toBe(false);
    expectI18nError(() => isRTL("en_US"), "invalid_locale");
  });

  it("passes the shared table", () => {
    stubNoIntlLocale();
    rtlChecks(isRTL);
  });

  it("agrees with Node's getTextInfo on every table tag and every RTL language", () => {
    const tags = [
      ...RTL_TAGS.map(([tag]) => tag),
      ...RTL_LANGUAGES,
      ...[...RTL_REGION_OVERRIDES.keys()],
    ];
    const expected = tags.map(nodeIsRTL);
    stubNoIntlLocale();
    expect(tags.map((tag) => isRTL(tag))).toEqual(expected);
  });

  it("throws intl_unavailable when even Intl.getCanonicalLocales is missing", () => {
    vi.stubGlobal("Intl", {});
    expectI18nError(() => isRTL("ar"), "intl_unavailable");
  });
});

describe("the RTL tables are Node 24's CLDR (oracle)", () => {
  const letters = "abcdefghijklmnopqrstuvwxyz";

  it("RTL_LANGUAGES = every 2- and 3-letter language whose likely script is RTL", () => {
    const found: string[] = [];
    const probe = (code: string) => {
      const max = new Intl.Locale(code).maximize();
      if (max.language === code && textDirection(max) === "rtl")
        found.push(code);
    };
    for (const x of letters) {
      for (const y of letters) {
        probe(x + y);
        for (const z of letters) probe(x + y + z);
      }
    }
    expect([...RTL_LANGUAGES].sort()).toEqual(found.sort());
    expect(RTL_LANGUAGES.has("ar")).toBe(true);
  }, 60_000);

  it("RTL_SCRIPTS = every ISO 15924-shaped script Node reports as RTL", () => {
    const found: string[] = [];
    for (const a of letters.toUpperCase()) {
      for (const b of letters) {
        for (const c of letters) {
          for (const d of letters) {
            const script = a + b + c + d;
            if (textDirection(new Intl.Locale(`und-${script}`)) === "rtl")
              found.push(script);
          }
        }
      }
    }
    expect([...RTL_SCRIPTS].sort()).toEqual(found.sort());
  }, 60_000);

  it("every region override flips its language's default direction on Node", () => {
    expect(RTL_REGION_OVERRIDES.size).toBeGreaterThan(0);
    for (const [tag, rtl] of RTL_REGION_OVERRIDES) {
      const language = tag.split("-")[0] ?? "";
      expect(nodeIsRTL(tag)).toBe(rtl);
      expect(nodeIsRTL(language)).toBe(!rtl);
    }
  });

  it("the tables are frozen sets", () => {
    expect(() => (RTL_LANGUAGES as Set<string>).add("en")).toThrow();
    expect(() => (RTL_SCRIPTS as Set<string>).add("Latn")).toThrow();
    expect(() =>
      (RTL_REGION_OVERRIDES as Map<string, boolean>).set("en-US", true),
    ).toThrow();
  });
});
