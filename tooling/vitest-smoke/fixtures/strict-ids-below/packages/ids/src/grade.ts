// Five statement lines. A test that only takes the pass branch covers four
// (80%), which sits between the 70% and 95% line thresholds.
export function grade(score: number): string {
  const rounded = Math.round(score);
  const passMark = 50;
  if (rounded >= passMark) {
    return "pass";
  }
  return "fail";
}
