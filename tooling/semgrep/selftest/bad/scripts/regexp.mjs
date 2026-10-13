// Known-bad: a pattern built from data (regex injection, ReDoS).
export function bad(id, text) {
  const a = new RegExp(`^- Advisory: ${id}$`, "m");
  const b = RegExp(id);
  return a.test(text) || b.test(text);
}
