import { defineConfig } from "vitest/config"

// Kernel modules read QWBE_* env at import time; only per-file isolation keeps one file's env
// out of the next file's imports.
export default defineConfig({
  test: {
    include: ["tools/**/*.test.ts"],
    isolate: true,
  },
})
