// The comparison helpers the import test relies on (P5-01, ADR 0060): a
// wrong helper would let a drifted realm pass, so each rule has a case that
// must report a problem.
import { describe, expect, test } from "vitest";
import { isArray, normalise, subsetProblems, text } from "../src/normalise.js";
import {
  loadRealm,
  placeholderNames,
  resolvePlaceholders,
  userProfileOf,
  withoutComponents,
} from "../src/realm.js";

describe("subsetProblems", () => {
  test("extra keys in the actual value are allowed", () => {
    expect(subsetProblems({ a: 1 }, { a: 1, b: 2 })).toEqual([]);
  });

  test("a missing or different value is reported with its path", () => {
    expect(subsetProblems({ a: { b: 1 } }, { a: {} })).toEqual([
      "$.a.b: missing",
    ]);
    expect(subsetProblems({ a: 300 }, { a: 600 })).toEqual([
      "$.a: expected 300, found 600",
    ]);
    expect(subsetProblems({ a: "300" }, { a: 300 })).toEqual([
      '$.a: expected "300", found 300',
    ]);
  });

  test("a shape mismatch is reported", () => {
    expect(subsetProblems({ a: [] }, { a: {} })).toEqual([
      "$.a: expected an array",
    ]);
    expect(subsetProblems({ a: {} }, { a: [] })).toEqual([
      "$.a: expected an object",
    ]);
  });

  test("primitive arrays must hold the same elements, in any order", () => {
    expect(subsetProblems(["a", "b"], ["b", "a"])).toEqual([]);
    expect(subsetProblems(["a"], ["a", "roles"])).toEqual([
      '$: expected ["a"], found ["a", "roles"]',
    ]);
    expect(subsetProblems([], ["x"])).toEqual(['$: expected [], found ["x"]']);
  });

  test("object arrays match by identity; extra elements are allowed", () => {
    const actual = [
      { clientId: "account", x: 1 },
      { clientId: "bricx-client", publicClient: true },
    ];
    expect(
      subsetProblems(
        [{ clientId: "bricx-client", publicClient: true }],
        actual,
      ),
    ).toEqual([]);
    expect(
      subsetProblems(
        [{ clientId: "bricx-client", publicClient: false }],
        actual,
      ),
    ).toEqual([
      "$[clientId=bricx-client].publicClient: expected false, found true",
    ]);
    expect(subsetProblems([{ clientId: "gone" }], actual)).toEqual([
      "$[clientId=gone]: expected one element, found 0",
    ]);
  });

  test("an expected element without an identity field is reported", () => {
    expect(subsetProblems([{ x: 1 }], [{ x: 1 }])).toEqual([
      "$: an expected element has no identity field",
    ]);
  });

  test("executions and mappers must match in count", () => {
    const expected = { authenticationExecutions: [{ authenticator: "a" }] };
    const actual = {
      authenticationExecutions: [
        { authenticator: "a" },
        { authenticator: "b" },
      ],
    };
    expect(subsetProblems(expected, actual)).toEqual([
      "$.authenticationExecutions: expected 1 elements, found 2",
    ]);
    expect(
      subsetProblems(
        { protocolMappers: [{ name: "m" }] },
        { protocolMappers: [{ name: "m" }, { name: "n" }] },
      ),
    ).toEqual(["$.protocolMappers: expected 1 elements, found 2"]);
  });
});

describe("normalise", () => {
  test("drops generated ids, the version and the key providers", () => {
    expect(
      normalise({
        id: "x",
        containerId: "y",
        keycloakVersion: "26",
        attributes: { "client.secret.creation.time": "1", kept: "2" },
        components: { "org.keycloak.keys.KeyProvider": [1], other: [2] },
        a: 1,
      }),
    ).toEqual({ a: 1, attributes: { kept: "2" }, components: { other: [2] } });
  });

  test("orders arrays and keys so two imports compare equal", () => {
    expect(normalise([{ b: 1, a: 2 }, "z", 1])).toEqual(
      normalise([1, "z", { a: 2, b: 1 }]),
    );
    expect(normalise([{ name: "a", id: "1" }])).not.toEqual(
      normalise([{ name: "b", id: "1" }]),
    );
  });
});

describe("isArray and text", () => {
  test("narrow without echoing the value", () => {
    expect(isArray([1])).toBe(true);
    expect(isArray({ a: 1 })).toBe(false);
    expect(text("x", "a")).toBe("x");
    expect(() => text(1, "the field")).toThrow(/^the field is not a string$/);
    expect(() => text(undefined, "the field")).toThrow(/not a string/);
  });
});

describe("the realm helpers", () => {
  test("placeholders resolve like Keycloak's import: value, default, literal", () => {
    expect(
      resolvePlaceholders(
        { a: "${A}", b: ["${B:dflt}", "x${A}y"], c: "${C}", d: 1 },
        { A: "1" },
      ),
    ).toEqual({ a: "1", b: ["dflt", "x1y"], c: "${C}", d: 1 });
    expect(placeholderNames({ a: ["${B}", "${A:x}"], b: "${B}" })).toEqual([
      "A",
      "B",
    ]);
  });

  test("the user profile comes from its component; components are split off", () => {
    const realm = loadRealm();
    expect(JSON.stringify(userProfileOf(realm))).toContain('"org_id"');
    expect(withoutComponents(realm)).not.toHaveProperty("components");
    expect(withoutComponents(realm)).toHaveProperty("realm", "bricx");
    expect(() => userProfileOf({ realm: "x" })).toThrow(/no declarative/);
  });
});
