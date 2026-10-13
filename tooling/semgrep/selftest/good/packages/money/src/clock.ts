// Known-good: time comes in as a parameter (the injected Clock).
export interface Clock {
  now(): number;
}
export function stamp(clock: Clock, iso: string): number {
  return clock.now() + new Date(iso).getTime();
}
