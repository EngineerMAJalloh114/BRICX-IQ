// ICU signature checks shared by icu.test.ts and sabotage.test.ts: generated
// messages in the subset the reference parser understands.
import fc from "fast-check";
import { expect } from "vitest";
import type { messageSignature } from "../src/icu.ts";
import { refSignature } from "./oracle.ts";

export type Signature = typeof messageSignature;

const name = fc.constantFrom("a", "b", "count2", "name", "total", "x_y");
const text = fc.constantFrom("", "x", " items ", "Done.", "عيب", "défaut");

const node = fc.letrec<{ node: string; body: string }>((tie) => ({
  body: fc.array(tie("node"), { maxLength: 3 }).map((parts) => parts.join("")),
  node: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    text,
    name.map((n) => `{${n}}`),
    name.map((n) => `{${n}, number}`),
    fc
      .tuple(
        name,
        fc.uniqueArray(fc.constantFrom("a1", "b2", "on_hold"), {
          maxLength: 2,
        }),
        tie("body"),
        tie("body"),
      )
      .map(
        ([n, keys, b1, b2]) =>
          `{${n}, select, ${keys.map((k) => `${k} {${b1}} `).join("")}other {${b2}}}`,
      ),
    fc
      .tuple(
        name,
        fc.constantFrom("plural", "selectordinal"),
        fc.subarray(["=0", "one", "two", "few", "many"]),
        tie("body"),
      )
      .map(
        ([n, kind, keys, b]) =>
          `{${n}, ${kind}, ${keys.map((k) => `${k} {# ${b}} `).join("")}other {#}}`,
      ),
  ),
}));

/** Messages whose signature the reference can compute (same name, same kind). */
export const messageArb = fc
  .array(node.node, { minLength: 1, maxLength: 3 })
  .map((parts) => parts.join(" "))
  .filter((m) => {
    try {
      refSignature(m);
      return m.length <= 1000;
    } catch {
      return false;
    }
  });

export function icuOracleChecks(signature: Signature, runs = 1_000): void {
  let bounded = 0;
  fc.assert(
    fc.property(messageArb, (message) => {
      const result = signature(message, "en");
      const ref = refSignature(message);
      if (!result.ok) {
        // Only the bounds may reject a message the reference accepts.
        expect(["too_many_placeholders", "nesting_too_deep"]).toContain(
          result.reason,
        );
        bounded += 1;
        return;
      }
      expect(result.signature.args).toEqual(ref.args);
      expect(result.signature.arms).toEqual(ref.arms);
    }),
    { numRuns: runs, seed: 303 },
  );
  // The comparison must cover most messages, not only bound rejections.
  expect(bounded).toBeLessThan(runs / 4);
}
