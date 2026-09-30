// Code under test for this package's own passing test (P1-04 proof a).
export function sum(values: readonly number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}
