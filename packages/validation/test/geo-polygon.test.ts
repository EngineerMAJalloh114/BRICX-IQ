// GeoPolygonSchema (P6-05, ADR 0075 D17; owner condition C6): a GeoJSON
// Polygon (RFC 7946) a site's boundary is stored from.
// - Bounded before any element is read: at most LIMITS.polygonRings rings
//   (one outer ring and at most 20 holes) and LIMITS.polygonPositions
//   positions in all; each ring closed, with at least 4 positions.
// - Each position is exactly [lng, lat], finite, 2-D, lng -180..180,
//   lat -90..90 (-0 stored as 0).
// - The output is normalised (C6): the outer ring counter-clockwise, every
//   hole clockwise (RFC 7946 section 3.1.6), so a clockwise and a
//   counter-clockwise input of the same polygon parse to the same value;
//   a ring with no area has no orientation and is refused.
// - Strict keys: type and coordinates only. Messages are keys, never input.
import { describe, expect, it } from "vitest";
import { GeoPolygonSchema } from "../src/geo.ts";
import { LIMITS } from "../src/limits.ts";
import { expectRejectedWithoutEcho, messagesOf, parsed } from "./helpers.ts";

type Ring = number[][];
const polygon = (...rings: Ring[]) => ({ type: "Polygon", coordinates: rings });

// Freetown, 0.01° square.
const CCW: Ring = [
  [-13.24, 8.48],
  [-13.23, 8.48],
  [-13.23, 8.49],
  [-13.24, 8.49],
  [-13.24, 8.48],
];
const CW: Ring = [...CCW].reverse();
const HOLE_CW: Ring = [
  [-13.238, 8.482],
  [-13.238, 8.488],
  [-13.232, 8.488],
  [-13.232, 8.482],
  [-13.238, 8.482],
];
const HOLE_CCW: Ring = [...HOLE_CW].reverse();

/** Twice the signed area (shoelace): > 0 counter-clockwise. */
const signedArea = (ring: Ring) => {
  let sum = 0;
  for (let i = 0; i + 1 < ring.length; i += 1) {
    const [x1 = 0, y1 = 0] = ring[i] ?? [];
    const [x2 = 0, y2 = 0] = ring[i + 1] ?? [];
    sum += x1 * y2 - x2 * y1;
  }
  return sum;
};

describe("GeoPolygonSchema accepts", () => {
  it("a counter-clockwise square, unchanged", () => {
    expect(parsed(GeoPolygonSchema, polygon(CCW))).toEqual(polygon(CCW));
  });

  it("CW and CCW input of the same polygon parse identically (C6)", () => {
    const fromCw = parsed(GeoPolygonSchema, polygon(CW));
    const fromCcw = parsed(GeoPolygonSchema, polygon(CCW));
    expect(fromCw).toEqual(fromCcw);
    expect(signedArea(fromCw.coordinates[0] ?? [])).toBeGreaterThan(0);
  });

  it("holes come out clockwise whatever their input orientation", () => {
    for (const hole of [HOLE_CW, HOLE_CCW]) {
      for (const outer of [CW, CCW]) {
        const out = parsed(GeoPolygonSchema, polygon(outer, hole));
        expect(signedArea(out.coordinates[0] ?? [])).toBeGreaterThan(0);
        expect(signedArea(out.coordinates[1] ?? [])).toBeLessThan(0);
        expect(out).toEqual(polygon(CCW, HOLE_CW));
      }
    }
  });

  it("stores -0 as 0", () => {
    const ring: Ring = [
      [-0, -0],
      [0.01, 0],
      [0.01, 0.01],
      [0, 0.01],
      [-0, -0],
    ];
    const out = parsed(GeoPolygonSchema, polygon(ring));
    expect(Object.is(out.coordinates[0]?.[0]?.[0], 0)).toBe(true);
    expect(Object.is(out.coordinates[0]?.[0]?.[1], 0)).toBe(true);
  });

  it("the bounds themselves: 20 holes, 1 000 positions, the edges of the globe", () => {
    expect(LIMITS.polygonRings).toBe(21);
    expect(LIMITS.polygonPositions).toBe(1000);
    const holes = Array.from({ length: 20 }, () => HOLE_CW);
    expect(GeoPolygonSchema.safeParse(polygon(CCW, ...holes)).success).toBe(
      true,
    );
    // One ring of 1 000 positions: 999 distinct points on a circle, closed.
    const big: Ring = Array.from({ length: 999 }, (_, i) => [
      Math.cos((2 * Math.PI * i) / 999) * 0.01,
      Math.sin((2 * Math.PI * i) / 999) * 0.01,
    ]);
    big.push([...(big[0] ?? [])]);
    expect(GeoPolygonSchema.safeParse(polygon(big)).success).toBe(true);
    const edges: Ring = [
      [-180, -90],
      [180, -90],
      [180, 90],
      [-180, 90],
      [-180, -90],
    ];
    expect(GeoPolygonSchema.safeParse(polygon(edges)).success).toBe(true);
  });
});

describe("GeoPolygonSchema rejects", () => {
  const P = "validation:invalid_polygon";
  it.each([
    ["an unclosed ring", polygon(CCW.slice(0, 4)), P],
    [
      "a ring of 3 positions",
      polygon([
        [0, 0],
        [1, 0],
        [0, 0],
      ]),
      P,
    ],
    ["a 3-D position", polygon(CCW.map(([x = 0, y = 0]) => [x, y, 5])), P],
    ["a 1-D position", polygon([[0], [1], [2], [0]]), P],
    [
      "NaN",
      polygon([
        [Number.NaN, 0],
        [1, 0],
        [1, 1],
        [Number.NaN, 0],
      ]),
      P,
    ],
    [
      "Infinity",
      polygon([
        [0, Infinity],
        [1, 0],
        [1, 1],
        [0, Infinity],
      ]),
      P,
    ],
    [
      "a string coordinate",
      polygon([
        ["0", 0],
        [1, 0],
        [1, 1],
        ["0", 0],
      ] as unknown as Ring),
      P,
    ],
    [
      "a longitude past 180",
      polygon([
        [180.5, 0],
        [181, 1],
        [180.5, 1],
        [180.5, 0],
      ]),
      "validation:invalid_longitude",
    ],
    [
      "a latitude past 90",
      polygon([
        [0, 90.5],
        [1, 90.5],
        [1, 91],
        [0, 90.5],
      ]),
      "validation:invalid_latitude",
    ],
    [
      "a ring with no area",
      polygon([
        [0, 0],
        [1, 1],
        [2, 2],
        [0, 0],
      ]),
      P,
    ],
    ["no ring", polygon(), P],
    ["a MultiPolygon", { type: "MultiPolygon", coordinates: [[CCW]] }, P],
    ["null", null, P],
    ["a string", "POLYGON((0 0,1 0,1 1,0 0))", P],
    ["coordinates not an array", { type: "Polygon", coordinates: {} }, P],
  ])("%s", (_label, input, message) => {
    expect(messagesOf(GeoPolygonSchema, input)).toEqual([message]);
  });

  it("an extra key (bbox, crs) as unknown_field", () => {
    expect(
      messagesOf(GeoPolygonSchema, { ...polygon(CCW), bbox: [0, 0, 1, 1] }),
    ).toEqual(["validation:unknown_field"]);
  });

  it("21 holes", () => {
    const holes = Array.from({ length: 21 }, () => HOLE_CW);
    expect(messagesOf(GeoPolygonSchema, polygon(CCW, ...holes))).toEqual([
      "validation:invalid_polygon",
    ]);
  });

  it("1 001 positions in all, before any position is read", () => {
    const ring: Ring = Array.from({ length: 1001 }, () => [0, 0]);
    let reads = 0;
    const counting = new Proxy(ring, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    expect(messagesOf(GeoPolygonSchema, polygon(counting))).toEqual([
      "validation:invalid_polygon",
    ]);
    expect(reads).toBe(0);
  });

  it("1 001 positions spread over rings", () => {
    const ring: Ring = Array.from({ length: 500 }, (_, i) => [
      Math.cos((2 * Math.PI * i) / 499) * 0.01,
      Math.sin((2 * Math.PI * i) / 499) * 0.01,
    ]);
    ring[499] = [...(ring[0] ?? [])];
    const third = CCW.slice(0, 1).concat(CCW.slice(1));
    expect(messagesOf(GeoPolygonSchema, polygon(ring, ring, third))).toEqual([
      "validation:invalid_polygon",
    ]);
  });

  it("never echoes its input", () => {
    expectRejectedWithoutEcho(GeoPolygonSchema, polygon(CCW.slice(0, 4)));
    expectRejectedWithoutEcho(GeoPolygonSchema, "POLYGON((12.3456 7))");
  });
});
