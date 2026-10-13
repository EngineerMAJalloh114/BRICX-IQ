// Known-bad: eval runs strings as code.
export function bad(code) {
  eval(code);
  globalThis.eval(code);
  return (0, eval)(code);
}
