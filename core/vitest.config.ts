import { defineConfig } from "vitest/config"

// Kernel modules read QWBE_* env at import time; only per-file isolation keeps one file's env
// out of the next file's imports. The fixtures are packs: their own tests run on node:test.
export default defineConfig({
  test: {
    include: ["tools/**/*.test.ts", "checks/**/*.test.ts"],
    exclude: ["**/node_modules/**", "checks/_fixtures/**"],
    isolate: true,
  },
})
