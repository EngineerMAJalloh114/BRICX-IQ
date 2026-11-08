// GeoPointSchema (P3-04 D7): a strict { lat, lng } object of finite
// numbers, lat -90..90 and lng -180..180 (WGS 84 degrees), -0 stored as 0.
// Named keys, not a GeoJSON [lng, lat] array; PostGIS ST_MakePoint takes
// (lng, lat), so callers pass point.lng first. More than LIMITS.objectKeys
// keys is rejected before any field is read.
import { z } from "zod";
import { boundedObject, issueMessage, typeError } from "./bounded.ts";
import { LIMITS } from "./limits.ts";
import type { ValidationCode } from "./codes.ts";

function coordinate(min: number, max: number, code: ValidationCode) {
  const message = issueMessage(code);
  return z
    .number({ error: typeError(message) })
    .check((ctx) => {
      if (ctx.value < min || ctx.value > max) {
        ctx.issues.push({
          code: "custom",
          message,
          input: undefined,
          continue: false,
        });
      }
    })
    .overwrite((value) => (Object.is(value, -0) ? 0 : value));
}

export const GeoPointSchema = boundedObject(
  z.strictObject(
    {
      lat: coordinate(-90, 90, "invalid_latitude"),
      lng: coordinate(-180, 180, "invalid_longitude"),
    },
    {
      error: (issue) =>
        issue.code === "unrecognized_keys"
          ? issueMessage("unknown_field")
          : typeError(issueMessage("invalid_geo_point"))(issue),
    },
  ),
);

export type GeoPoint = z.output<typeof GeoPointSchema>;

// GeoPolygonSchema (P6-05, ADR 0075 D17; owner condition C6): a GeoJSON
// Polygon (RFC 7946) a site's boundary is stored from, exactly
// { type: "Polygon", coordinates: [ring, ...] }.
// - Bounded before any position is read: at most LIMITS.polygonRings
//   rings (one outer ring and at most 20 holes) and
//   LIMITS.polygonPositions positions in all, counted from the rings'
//   lengths; each ring has at least 4 positions and is closed.
// - Each position is exactly [lng, lat] of finite numbers, lng -180..180,
//   lat -90..90 (invalid_longitude / invalid_latitude), -0 stored as 0.
// - Normalised (C6): the outer ring counter-clockwise, every hole
//   clockwise (RFC 7946 section 3.1.6), so a clockwise and a
//   counter-clockwise input of the same polygon parse to the same value
//   (PostGIS geography reads a clockwise outer ring as its complement,
//   the rest of the globe). A ring with no area has no orientation and is
//   refused. Self-intersection and the area bound are the database's
//   CHECKs (ST_IsValid, ST_Area), mapped to 422 by the API.
// - One issue per rejection, its message a key; never the input.

/** A parsed polygon: rings of [lng, lat], outer counter-clockwise, holes clockwise. */
export interface GeoPolygon {
  readonly type: "Polygon";
  readonly coordinates: [number, number][][];
}

type PolygonProblem =
  | "invalid_polygon"
  | "unknown_field"
  | "invalid_longitude"
  | "invalid_latitude";

const POLYGON_KEYS: ReadonlySet<string> = new Set(["type", "coordinates"]);

/** Twice the signed area (shoelace): > 0 counter-clockwise, < 0 clockwise. */
function signedArea(ring: readonly (readonly [number, number])[]): number {
  let sum = 0;
  for (let i = 0; i + 1 < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[i + 1];
    /* v8 ignore next -- every index is in range */
    if (a === undefined || b === undefined) continue;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum;
}

/** The position as [lng, lat] (-0 as 0), or the problem. */
function readPosition(value: unknown): [number, number] | PolygonProblem {
  if (!Array.isArray(value) || value.length !== 2) return "invalid_polygon";
  const lng: unknown = value[0];
  const lat: unknown = value[1];
  if (
    typeof lng !== "number" ||
    typeof lat !== "number" ||
    !Number.isFinite(lng) ||
    !Number.isFinite(lat)
  ) {
    return "invalid_polygon";
  }
  if (lng < -180 || lng > 180) return "invalid_longitude";
  if (lat < -90 || lat > 90) return "invalid_latitude";
  return [lng === 0 ? 0 : lng, lat === 0 ? 0 : lat];
}

/** The polygon, normalised, or the one problem it has. */
function readPolygon(value: unknown): GeoPolygon | PolygonProblem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "invalid_polygon";
  }
  // Any key but type and coordinates (bbox, crs, ...) is unknown; the
  // loop stops at the first one, so a huge object costs one step more.
  for (const key in value) {
    if (Object.hasOwn(value, key) && !POLYGON_KEYS.has(key)) {
      return "unknown_field";
    }
  }
  const record = value as Record<string, unknown>;
  if (record["type"] !== "Polygon") return "invalid_polygon";
  const rings: unknown = record["coordinates"];
  if (
    !Array.isArray(rings) ||
    rings.length < 1 ||
    rings.length > LIMITS.polygonRings
  ) {
    return "invalid_polygon";
  }
  // Every ring's length before any position is read.
  let positions = 0;
  const raw: unknown[][] = [];
  for (const ring of rings as unknown[]) {
    if (!Array.isArray(ring) || ring.length < 4) return "invalid_polygon";
    positions += ring.length;
    if (positions > LIMITS.polygonPositions) return "invalid_polygon";
    raw.push(ring as unknown[]);
  }
  const out: [number, number][][] = [];
  for (const [index, ring] of raw.entries()) {
    const read: [number, number][] = [];
    for (const item of ring) {
      const position = readPosition(item);
      if (typeof position === "string") return position;
      read.push(position);
    }
    const first = read[0];
    const last = read[read.length - 1];
    if (
      first === undefined ||
      last === undefined ||
      first[0] !== last[0] ||
      first[1] !== last[1]
    ) {
      return "invalid_polygon";
    }
    const area = signedArea(read);
    if (area === 0) return "invalid_polygon";
    // The outer ring counter-clockwise (area > 0), every hole clockwise.
    const wantCounterClockwise = index === 0;
    out.push(area > 0 === wantCounterClockwise ? read : read.reverse());
  }
  return { type: "Polygon", coordinates: out };
}

/** The JSON Schema of the wire shape, for OpenAPI (the parse itself is code). */
const POLYGON_JSON_SCHEMA = {
  type: "object",
  description:
    "A GeoJSON Polygon (RFC 7946) in [longitude, latitude]: at most 21 rings and 1000 positions in all, each ring closed with at least 4 positions. Stored with the outer ring counter-clockwise and holes clockwise.",
  properties: {
    type: { type: "string", const: "Polygon" },
    coordinates: {
      type: "array",
      minItems: 1,
      maxItems: 21,
      items: {
        type: "array",
        minItems: 4,
        items: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: { type: "number" },
        },
      },
    },
  },
  required: ["type", "coordinates"],
  additionalProperties: false,
} as const;

export const GeoPolygonSchema = z
  .unknown()
  .transform((value, ctx): GeoPolygon => {
    const polygon = readPolygon(value);
    if (typeof polygon === "string") {
      ctx.issues.push({
        code: "custom",
        message: issueMessage(polygon),
        input: undefined,
        continue: false,
      });
      return z.NEVER;
    }
    return polygon;
  })
  .meta(POLYGON_JSON_SCHEMA);

/** The stored shape, for responses (already normalised; no transform). */
export const GeoPolygonOutputSchema = z
  .strictObject({
    type: z.literal("Polygon"),
    coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
  })
  .meta({ description: POLYGON_JSON_SCHEMA.description });
