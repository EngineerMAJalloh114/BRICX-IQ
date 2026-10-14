// GeoPointSchema (P3-04 D7): a strict { lat, lng } object of finite numbers,
// lat -90..90, lng -180..180, -0 stored as 0. Named keys, not a GeoJSON
// [lng, lat] array; PostGIS takes (lng, lat), the ADR says so.
import { describe, expect, it } from "vitest";
import { GeoPointSchema } from "../src/geo.ts";
import { messagesOf, parsed } from "./helpers.ts";

describe("GeoPointSchema accepts", () => {
  it.each([
    [{ lat: 8.4657, lng: -13.2317 }],
    [{ lat: 0, lng: 0 }],
    [{ lat: 90, lng: 180 }],
    [{ lat: -90, lng: -180 }],
    [{ lat: 51.5007292, lng: -0.1246254 }],
  ])("%j", (input) => {
    expect(parsed(GeoPointSchema, input)).toEqual(input);
  });

  it("stores -0 as 0", () => {
    const point = parsed(GeoPointSchema, { lat: -0, lng: -0 });
    expect(Object.is(point.lat, 0)).toBe(true);
    expect(Object.is(point.lng, 0)).toBe(true);
  });
});

describe("GeoPointSchema rejects", () => {
  it.each([
    [
      "lat above 90",
      { lat: 90.0000001, lng: 0 },
      "validation:invalid_latitude",
    ],
    ["lat below -90", { lat: -91, lng: 0 }, "validation:invalid_latitude"],
    ["lng above 180", { lat: 0, lng: 180.5 }, "validation:invalid_longitude"],
    ["lng below -180", { lat: 0, lng: -181 }, "validation:invalid_longitude"],
    ["NaN", { lat: Number.NaN, lng: 0 }, "validation:invalid_latitude"],
    ["Infinity", { lat: 0, lng: Infinity }, "validation:invalid_longitude"],
    ["string lat", { lat: "8.46", lng: 0 }, "validation:invalid_latitude"],
    ["missing lat", { lng: 0 }, "validation:required"],
    ["missing lng", { lat: 0 }, "validation:required"],
  ])("%s", (_label, input, message) => {
    expect(messagesOf(GeoPointSchema, input)).toEqual([message]);
  });

  it("an extra key as unknown_field", () => {
    expect(messagesOf(GeoPointSchema, { lat: 0, lng: 0, alt: 10 })).toEqual([
      "validation:unknown_field",
    ]);
  });

  it.each([
    ["an array", [0, 0]],
    ["null", null],
    ["a string", "8.4,-13.2"],
  ])("%s", (_label, input) => {
    expect(messagesOf(GeoPointSchema, input)).toEqual([
      "validation:invalid_geo_point",
    ]);
  });

  it("an object with too many keys as too_large, before any field is read", () => {
    const input: Record<string, number> = { lat: 0, lng: 0 };
    for (let i = 0; i < 100; i += 1) input[`k${String(i)}`] = i;
    expect(messagesOf(GeoPointSchema, input)).toEqual(["validation:too_large"]);
  });
});
