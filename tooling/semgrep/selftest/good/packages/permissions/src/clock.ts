// Known-good: time comes in as a parameter.
export const issuedAt = (clock: { now(): number }): number => clock.now();
