// orval (P4-08, ADR 0058, decision 7): openapi.json (written by
// `pnpm --filter @bricx/api openapi:emit`) -> src/generated/client.ts, a
// fetch client whose every operation calls src/fetcher.ts's customFetch.
// TanStack Query hooks come at P7-01 (a second output here).
import { defineConfig } from "orval";

export default defineConfig({
  bricx: {
    input: { target: "./openapi.json" },
    output: {
      target: "./src/generated/client.ts",
      client: "fetch",
      mode: "single",
      clean: true,
      override: {
        mutator: { path: "./src/fetcher.ts", name: "customFetch" },
      },
    },
  },
});
