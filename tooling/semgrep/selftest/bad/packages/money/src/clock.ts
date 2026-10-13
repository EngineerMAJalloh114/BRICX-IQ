// Known-bad: money code reads the real clock and Math.random.
export function stamp(): number {
  const a = Date.now();
  const b = new Date();
  return a + b.getTime() + Math.random();
}
