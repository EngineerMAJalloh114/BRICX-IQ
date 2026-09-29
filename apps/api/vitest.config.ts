import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests share one PostgreSQL database, so run files one at a time.
    fileParallelism: false,
  },
});
