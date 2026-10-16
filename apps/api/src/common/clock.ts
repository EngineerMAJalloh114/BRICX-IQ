// The real clock, injected at the composition root (CLAUDE.md rule 7):
// code below the app receives a Clock instead of calling Date.now().
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** The Nest injection token for the Clock (P4-05: AuditModule). */
export const CLOCK = Symbol("CLOCK");
