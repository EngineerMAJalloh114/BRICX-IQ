// Resolves after `ms` milliseconds: a correct test that is slower than
// Vitest's 5000 ms default, as unit tests are under `pnpm verify` load.
export function wait(ms: number): Promise<number> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(ms);
    }, ms);
  });
}
