// The generator: RFC 9562 layout, the timestamp field, ordering within and
// across milliseconds, a clock that goes backwards, and the injected
// clock and random source (P3-01, ADR 0041).
import { describe, expect, it } from "vitest";
import { IdError, createUuidV7Generator } from "../src/uuid-v7.js";
import {
  bitsOf,
  constantRandom,
  expectStrictlyIncreasing,
  expectVersionAndVariant,
  frozenClock,
  generate,
  seededRandom,
  sequenceClock,
  steppingClock,
  timestampField,
} from "./helpers.js";

// RFC 9562 Appendix A.6: 2022-02-22T19:22:22.000Z.
const RFC_MS = 0x017f22e279b0;
const MAX_MS = 2 ** 48 - 1;

describe("layout", () => {
  it("packs timestamp, version, counter, variant and random tail exactly (all-zero random)", () => {
    const ids = createUuidV7Generator({
      clock: frozenClock(RFC_MS),
      fillRandom: constantRandom(0x00),
    });
    expect(ids.next()).toBe("017f22e2-79b0-7000-8000-000000000000");
    expect(ids.next()).toBe("017f22e2-79b0-7000-8000-000100000000");
  });

  it("seeds the counter with 41 random bits, top counter bit clear (all-0xff random)", () => {
    const ids = createUuidV7Generator({
      clock: frozenClock(RFC_MS),
      fillRandom: constantRandom(0xff),
    });
    expect(ids.next()).toBe("017f22e2-79b0-77ff-bfff-ffffffffffff");
    // Next counter value is 2^41: the counter's top bit is now set.
    expect(ids.next()).toBe("017f22e2-79b0-7800-8000-0000ffffffff");
  });

  it("every id is lowercase version 7, variant 10", () => {
    const ids = createUuidV7Generator({
      clock: steppingClock(RFC_MS, 7, 50, 3),
      fillRandom: seededRandom(42),
    });
    expectVersionAndVariant(generate(() => ids.next(), 10_000));
  });
});

describe("the 48-bit timestamp field equals the injected clock, bit for bit", () => {
  const values = [
    0,
    1,
    0xff,
    0x100,
    0xffff_ffff,
    0x1_0000_0000,
    RFC_MS,
    2 ** 47,
    MAX_MS - 1,
    MAX_MS,
  ];
  const random = seededRandom(7);
  const bytes = new Uint8Array(6);
  for (let i = 0; i < 200; i += 1) {
    random(bytes);
    values.push(bytes.reduce((acc, b) => acc * 256 + b, 0));
  }

  it.each(values)("clock %d", (ms) => {
    const id = createUuidV7Generator({
      clock: frozenClock(ms),
      fillRandom: seededRandom(ms + 1),
    }).next();
    expect(timestampField(id)).toBe(BigInt(ms));
    expect(bitsOf(id) >> 80n).toBe(BigInt(ms));
  });

  it("a running generator stamps each id with the clock value it read", () => {
    let current = RFC_MS;
    const ids = createUuidV7Generator({
      clock: { now: () => current },
      fillRandom: seededRandom(3),
    });
    for (let i = 0; i < 1_000; i += 1) {
      current += i % 3;
      expect(timestampField(ids.next())).toBe(BigInt(current));
    }
  });
});

describe("ordering", () => {
  it("is strictly increasing within one millisecond", () => {
    const ids = createUuidV7Generator({
      clock: frozenClock(RFC_MS),
      fillRandom: seededRandom(1),
    });
    expectStrictlyIncreasing(generate(() => ids.next(), 100_000));
  });

  it("crosses a millisecond boundary in order, even from the largest seed to the smallest", () => {
    let ms = RFC_MS;
    let fill = 0xff;
    const ids = createUuidV7Generator({
      clock: { now: () => ms },
      fillRandom: (bytes) => {
        bytes.fill(fill);
      },
    });
    const before = [ids.next(), ids.next()];
    ms += 1;
    fill = 0x00;
    const after = [ids.next(), ids.next()];
    const all = [...before, ...after];
    expectStrictlyIncreasing(all);
    expect([...all].sort()).toEqual(all);
    expect(timestampField(after[0] ?? "")).toBe(BigInt(RFC_MS + 1));
  });

  it("stays strictly increasing when the clock goes backwards, and never stamps an earlier time", () => {
    const clock = sequenceClock([1000, 999, 500, 0, 1000, 1001, 1001, 2]);
    const ids = createUuidV7Generator({ clock, fillRandom: seededRandom(9) });
    const out = generate(() => ids.next(), 8);
    expectStrictlyIncreasing(out);
    const stamps = out.map(timestampField);
    expect(stamps).toEqual([
      1000n,
      1000n,
      1000n,
      1000n,
      1000n,
      1001n,
      1001n,
      1001n,
    ]);
  });
});

describe("injected clock and random source", () => {
  it("reads the clock once per id and fills 10 random bytes per id", () => {
    let clockReads = 0;
    const sizes: number[] = [];
    const ids = createUuidV7Generator({
      clock: {
        now: () => {
          clockReads += 1;
          return RFC_MS;
        },
      },
      fillRandom: (bytes) => {
        sizes.push(bytes.length);
        bytes.fill(1);
      },
    });
    generate(() => ids.next(), 5);
    expect(clockReads).toBe(5);
    expect(sizes).toEqual([10, 10, 10, 10, 10]);
  });

  it("is deterministic for a fixed clock and seeded random source (P6-05b seeds)", () => {
    const make = () =>
      createUuidV7Generator({
        clock: steppingClock(RFC_MS, 3),
        fillRandom: seededRandom(2026),
      });
    const a = make();
    const b = make();
    expect(generate(() => a.next(), 1_000)).toEqual(
      generate(() => b.next(), 1_000),
    );
  });

  it("two generators keep separate state", () => {
    const a = createUuidV7Generator({
      clock: frozenClock(RFC_MS),
      fillRandom: constantRandom(0),
    });
    const b = createUuidV7Generator({
      clock: frozenClock(RFC_MS),
      fillRandom: constantRandom(0),
    });
    a.next();
    expect(b.next()).toBe("017f22e2-79b0-7000-8000-000000000000");
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative", -1],
    ["fraction", 1.5],
    ["above 48 bits", 2 ** 48],
    ["a string", "1000" as unknown as number],
  ])("rejects a clock returning %s with invalid_clock", (_name, value) => {
    const ids = createUuidV7Generator({
      clock: { now: () => value },
      fillRandom: seededRandom(1),
    });
    expect(() => ids.next()).toThrow(IdError);
    expect(() => ids.next()).toThrow(
      expect.objectContaining({ code: "invalid_clock" }),
    );
  });
});
