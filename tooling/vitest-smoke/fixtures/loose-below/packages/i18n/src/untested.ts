// No test imports this file. It must still count towards coverage, which
// pulls this package below the 70% line threshold.
export function label(code: string): string {
  const trimmed = code.trim();
  const upper = trimmed.toUpperCase();
  const padded = upper.padStart(4, "0");
  return `ID-${padded}`;
}
