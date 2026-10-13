// Known-good: a Testcontainers exec takes an argv array and is not
// child_process.
export async function probe(container) {
  return container.exec(["wget", "-q", "--spider", "http://127.0.0.1:8888/"]);
}
