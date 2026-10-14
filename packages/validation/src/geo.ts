// GeoPointSchema (P3-04 D7): a strict { lat, lng } object of finite
// numbers, lat -90..90 and lng -180..180 (WGS 84 degrees), -0 stored as 0.
// Named keys, not a GeoJSON [lng, lat] array; PostGIS ST_MakePoint takes
// (lng, lat), so callers pass point.lng first. More than LIMITS.objectKeys
// keys is rejected before any field is read.
import { z } from "zod";
import { boundedObject, issueMessage, typeError } from "./bounded.ts";
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
