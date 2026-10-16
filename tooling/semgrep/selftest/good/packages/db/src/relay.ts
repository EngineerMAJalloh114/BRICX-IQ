// Known-good: packages/db defines openRelayDatabase and withRelayTx.
export function openRelayDatabase(url: { reveal(): string }) {
  return {
    async withRelayTx<T>(fn: (tx: string) => Promise<T>) {
      return fn(url.reveal());
    },
  };
}
export const handle = openRelayDatabase({ reveal: () => "x" });
await handle.withRelayTx(async (tx) => tx);
