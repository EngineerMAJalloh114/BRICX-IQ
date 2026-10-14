// Bounds checked before any loop, lookup or regex runs (P3-06 design
// constraint 5). Oversized input is rejected without reading it.
export const LIMITS = Object.freeze({
  /** States in one machine definition (final states are a subset). */
  machineStates: 64,
  /** Events in one machine definition. */
  machineEvents: 64,
  /** Transitions in one machine definition. */
  machineTransitions: 256,
  /** Named guards in one machine definition. */
  machineGuards: 32,
  /** Characters in a machine id, state, event or guard name, and in any name coming in. */
  nameLength: 64,
  /** Characters in a quantity decimal string. */
  quantityString: 40,
  /** Characters in a unit code coming in. */
  unitCode: 16,
  /** Integer digits of a quantity (999 999 999 999 is the largest magnitude). */
  integerDigits: 12,
  /** The largest scale (fraction digits) of a quantity. */
  maxScale: 9,
  /** Characters in a country code (ISO 3166-1 alpha-2). */
  countryCode: 2,
});
