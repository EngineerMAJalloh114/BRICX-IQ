// Known-good: counts and non-money numbers may be numbers.
export function good(row: Record<string, string>): number {
  const count = Number(row.count);
  const page = parseInt(row["page"] ?? "1", 10);
  return +row.quantity + count + page;
}
