// Conversion factors re-derived (design constraint 3, ruling 6). The
// stored factors in src/units-data.ts are decimal strings; this test builds
// every one again from the base definitions by a separate route, as exact
// bigint rationals, and requires equality:
//   SI prefixes as powers of ten (BIPM SI Brochure);
//   in = 0.0254 m and lb = 0.45359237 kg (international yard and pound,
//   1959; NIST HB 44 Appendix C, NIST SP 811 Appendix B);
//   ft = 12 in, yd = 3 ft, mi = 5280 ft; squares and cubes of these;
//   ac = 43 560 ft2; US gal = 231 in3; imperial gal = 4.54609 L (UK Weights
//   and Measures Act 1985, Schedule 1); oz = lb / 16; short ton = 2000 lb;
//   long ton = 2240 lb; ha = 10 000 m2; L = 1 dm3.
import { describe, expect, it } from "vitest";
import { UNITS } from "../src/units.ts";

interface Rational {
  readonly n: bigint;
  readonly d: bigint;
}

const gcd = (a: bigint, b: bigint): bigint => {
  let x = a < 0n ? -a : a;
  let y = b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
};
const r = (n: bigint, d = 1n): Rational => {
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
};
const mul = (a: Rational, b: Rational): Rational => r(a.n * b.n, a.d * b.d);
const div = (a: Rational, b: Rational): Rational => r(a.n * b.d, a.d * b.n);
const pow = (a: Rational, k: number): Rational =>
  k === 0 ? r(1n) : mul(a, pow(a, k - 1));
const int = (n: number): Rational => r(BigInt(n));
const tenTo = (k: number): Rational =>
  k >= 0 ? r(10n ** BigInt(k)) : r(1n, 10n ** BigInt(-k));

/** A decimal string as a rational, by a route unlike src's parser. */
function fromDecimal(s: string): Rational {
  const [whole = "", frac = ""] = s.split(".");
  return r(BigInt(whole + frac), 10n ** BigInt(frac.length));
}

// Base definitions.
const inch = r(254n, 10000n); // 0.0254 m
const pound = r(45359237n, 100000000n); // 0.45359237 kg
const foot = mul(int(12), inch);
const yard = mul(int(3), foot);
const mile = mul(int(5280), foot);
const litre = pow(tenTo(-1), 3); // 1 dm3

const DERIVED: Readonly<Record<string, Rational>> = {
  mm: tenTo(-3),
  cm: tenTo(-2),
  m: int(1),
  km: tenTo(3),
  in: inch,
  ft: foot,
  yd: yard,
  mi: mile,
  mm2: pow(tenTo(-3), 2),
  cm2: pow(tenTo(-2), 2),
  m2: int(1),
  ha: mul(int(10000), int(1)),
  km2: pow(tenTo(3), 2),
  in2: pow(inch, 2),
  ft2: pow(foot, 2),
  yd2: pow(yard, 2),
  ac: mul(int(43560), pow(foot, 2)),
  mi2: pow(mile, 2),
  cm3: pow(tenTo(-2), 3),
  l: litre,
  m3: int(1),
  in3: pow(inch, 3),
  ft3: pow(foot, 3),
  yd3: pow(yard, 3),
  us_gal: mul(int(231), pow(inch, 3)),
  imp_gal: mul(r(454609n, 100000n), litre),
  g: tenTo(-3),
  kg: int(1),
  t: tenTo(3),
  oz: div(pound, int(16)),
  lb: pound,
  short_ton: mul(int(2000), pound),
  long_ton: mul(int(2240), pound),
  ea: int(1),
};

describe("every stored factor equals its independent derivation", () => {
  it("covers all 34 units, no more, no fewer", () => {
    expect(Object.keys(DERIVED).sort()).toEqual(
      UNITS.map((u) => u.code).sort(),
    );
    expect(UNITS).toHaveLength(34);
  });

  it.each(UNITS.map((u) => [u.code, u.factor] as const))(
    "%s = %s",
    (unit, factor) => {
      expect(fromDecimal(factor)).toEqual(DERIVED[unit]);
    },
  );

  it("every stored factor is a plain, positive, terminating decimal", () => {
    for (const u of UNITS) {
      expect(u.factor).toMatch(/^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/);
      expect(u.factor).not.toBe("0");
    }
  });
});
