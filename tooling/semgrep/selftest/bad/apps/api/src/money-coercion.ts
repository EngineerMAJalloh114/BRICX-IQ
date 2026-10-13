// Known-bad: money coerced to a float in ways a name-only lint misses.
export function bad(
  row: Record<string, string>,
  line: { amount: { value: string } },
): number {
  const a = +row.amount;
  const b = parseFloat(row["unitPrice"]);
  const c = Number(String(line.amount.value));
  const d = Number.parseFloat(`${row.total}`);
  return a + b + c + d;
}
