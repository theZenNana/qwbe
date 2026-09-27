import { defineConfig } from "vitest/config"
import { ONE_FILE_AT_A_TIME } from "./vitest.config.ts"

// `check --live` (`npm run test:live`): each file boots real servers over its own Postgres
// database, so boots also must not compete for connections.
export default defineConfig({
  test: {
    include: ["checks/live/**/*.test.ts"],
    ...ONE_FILE_AT_A_TIME,
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
})
