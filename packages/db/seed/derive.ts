// Seed id derivation (P6-05b, ADR 0076; binding decision F, requirement
// 3): the UUIDv7 a dataset name stands for, made by @bricx/ids on the
// seed instant with the "random" bits taken from SHA-256 of the name. So
// each committed literal in ids.ts can be reproduced from its name alone
// (the dataset test does), whatever order the names come in, and nothing
// here reads a clock or a random source. Used by generate-ids.ts and the
// tests only; the seed itself reads the committed literals.
import { createHash } from "node:crypto";
import { fixedClock } from "@bricx/domain/clock";
import { createUuidV7Generator } from "@bricx/ids/uuid-v7";
import { SEED_INSTANT_MS } from "./dataset.js";

const clock = fixedClock(SEED_INSTANT_MS);

/** The UUIDv7 for dataset name `name`. */
export function deriveSeedId(name: string): string {
  let call = 0;
  const generator = createUuidV7Generator({
    clock,
    fillRandom(bytes) {
      const digest = createHash("sha256")
        .update(`bricx-seed:${name}:${String(call)}`)
        .digest();
      call += 1;
      bytes.set(digest.subarray(0, bytes.length));
    },
  });
  return generator.next();
}
