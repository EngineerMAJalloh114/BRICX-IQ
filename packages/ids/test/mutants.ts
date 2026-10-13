// Deliberately broken implementations for the sabotage tests (P3 rule 1).
// Each is the real code with one defect; the checks in the real tests must
// reject every one of them.
import { createUuidV7Generator, parseUuidV7 } from "../src/uuid-v7.js";
import type {
  FillRandom,
  IdClock,
  UuidV7,
  UuidV7Generator,
} from "../src/uuid-v7.js";

export type Make = (clock: IdClock, fillRandom: FillRandom) => UuidV7Generator;

const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");

/** Formats an id the way the real generator does, from raw fields. */
function format(ms: number, counter: number, tail: number): string {
  const ts = hex(ms, 12);
  const randA = Math.floor(counter / 2 ** 30);
  const low30 = counter % 2 ** 30;
  const group4 = 0x8000 | Math.floor(low30 / 2 ** 16);
  return `${ts.slice(0, 8)}-${ts.slice(8)}-7${hex(randA, 3)}-${hex(group4, 4)}-${hex(low30 % 2 ** 16, 4)}${hex(tail, 8)}`;
}

function seedOf(bytes: Uint8Array): number {
  let seed = (bytes[0] ?? 0) & 0x01;
  for (let i = 1; i <= 5; i += 1) seed = seed * 256 + (bytes[i] ?? 0);
  return seed;
}

function tailOf(bytes: Uint8Array): number {
  return (
    (((bytes[6] ?? 0) << 24) >>> 0) +
    ((bytes[7] ?? 0) << 16) +
    ((bytes[8] ?? 0) << 8) +
    (bytes[9] ?? 0)
  );
}

/** Reseeds on every call instead of incrementing within a millisecond. */
export const counterNeverIncrements: Make = (clock, fillRandom) => {
  const bytes = new Uint8Array(10);
  return {
    next: () => {
      fillRandom(bytes);
      return format(clock.now(), seedOf(bytes), tailOf(bytes)) as UuidV7;
    },
  };
};

/** Follows a clock that goes backwards instead of holding the last ms. */
export const followsBackwardsClock: Make = (clock, fillRandom) => {
  const bytes = new Uint8Array(10);
  let last = -1;
  let counter = 0;
  return {
    next: () => {
      const now = clock.now();
      fillRandom(bytes);
      counter = now === last ? counter + 1 : seedOf(bytes);
      last = now;
      return format(now, counter, tailOf(bytes)) as UuidV7;
    },
  };
};

/** Correct ordering, but the timestamp loses its top 16 bits. */
export const truncatedTimestamp: Make = (clock, fillRandom) => {
  const real = createUuidV7Generator({ clock, fillRandom });
  return {
    next: () => {
      const id = real.next();
      return `0000${id.slice(4)}` as UuidV7;
    },
  };
};

/** Writes variant 11 (Microsoft) instead of 10. */
export const wrongVariant: Make = (clock, fillRandom) => {
  const real = createUuidV7Generator({ clock, fillRandom });
  return {
    next: () => {
      const id = real.next();
      return `${id.slice(0, 19)}c${id.slice(20)}` as UuidV7;
    },
  };
};

/** Writes version 4 instead of 7. */
export const wrongVersion: Make = (clock, fillRandom) => {
  const real = createUuidV7Generator({ clock, fillRandom });
  return {
    next: () => {
      const id = real.next();
      return `${id.slice(0, 14)}4${id.slice(15)}` as UuidV7;
    },
  };
};

/** Accepts uppercase by lowercasing first. */
export const parseAcceptsUppercase = (input: unknown) =>
  parseUuidV7(typeof input === "string" ? input.toLowerCase() : input);

/** Accepts any version. */
export const parseAcceptsAnyVersion = (input: unknown) =>
  parseUuidV7(
    typeof input === "string"
      ? `${input.slice(0, 14)}7${input.slice(15)}`
      : input,
  );

/** Echoes the input in the error message. */
export const parseEchoesInput = (input: unknown) => {
  try {
    return parseUuidV7(input);
  } catch {
    throw new Error(`invalid id: ${String(input)}`);
  }
};
