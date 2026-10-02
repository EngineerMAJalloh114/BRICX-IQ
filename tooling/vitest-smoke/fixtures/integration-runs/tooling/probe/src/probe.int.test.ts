import { expect, test } from "vitest";

test("integration probe", () => {
  expect(process.env["RYUK_CONTAINER_IMAGE"]).toMatch(
    /^testcontainers\/ryuk:[\d.]+@sha256:[0-9a-f]{64}$/,
  );
});
