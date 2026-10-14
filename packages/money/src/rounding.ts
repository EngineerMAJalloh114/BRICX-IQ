// Rounding modes (P3-02 ruling: an explicit enum; no default except
// HALF_EVEN for convert). Directions follow decimal.js.
export const Rounding = {
  /** To nearest; ties to the even neighbour (banker's rounding). */
  HALF_EVEN: "HALF_EVEN",
  /** To nearest; ties away from zero. */
  HALF_UP: "HALF_UP",
  /** To nearest; ties towards zero. */
  HALF_DOWN: "HALF_DOWN",
  /** Away from zero. */
  UP: "UP",
  /** Towards zero (truncate). */
  DOWN: "DOWN",
  /** Towards +infinity. */
  CEILING: "CEILING",
  /** Towards -infinity. */
  FLOOR: "FLOOR",
} as const;

export type Rounding = (typeof Rounding)[keyof typeof Rounding];

const modes: ReadonlySet<unknown> = new Set(Object.values(Rounding));

export const isRounding = (value: unknown): value is Rounding =>
  modes.has(value);
