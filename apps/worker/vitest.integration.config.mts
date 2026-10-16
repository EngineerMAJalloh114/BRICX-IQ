import { integrationPreset } from "@bricx/vitest-config";

// Integration tests only (*.int.test.ts, Docker required), run by
// `pnpm test:integration`: Postgres and Valkey from compose.yml's images.
export default integrationPreset({ packageDir: import.meta.dirname });
