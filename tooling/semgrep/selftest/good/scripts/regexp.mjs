// Known-good: literal patterns, or plain string comparison.
export function good(id, text) {
  const a = new RegExp("^- Advisory: ", "m");
  const b = /^GHSA(?:-[0-9a-z]{4}){3}$/;
  return (
    a.test(text) && b.test(id) && text.split("\n").includes(`- Advisory: ${id}`)
  );
}
