// Known-bad: permissions code reads the real clock.
export const issuedAt = (): number => Date.now();
