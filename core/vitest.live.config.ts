import { defineConfig } from "vitest/config"

// `check --live` (`npm run test:live`): each file boots real servers over its own Postgres
// database. One file at a time, so boots do not compete for CPU and connections.
export default defineConfig({
  test: {
    include: ["checks/live/**/*.test.ts"],
    isolate: true,
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
})
