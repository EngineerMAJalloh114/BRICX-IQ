/** @param {boolean} open */
export function label(open) {
  let text = "unknown";
  text = open ? "open" : "closed";
  return text;
}
