import { defineConfig } from "vitest/config";

// Database tests: real Postgres (the compose `db` service, *_test database).
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/db/**/*.test.ts"],
    globalSetup: ["test/db/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
