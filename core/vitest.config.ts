import { defineConfig } from "vitest/config"

// Kernel modules read QWBE_* env at import time; only per-file isolation keeps one file's env
// out of the next file's imports.
const ISOLATED = { isolate: true } as const

/** For the live and bench configs: files that boot real servers must not compete for CPU. */
export const ONE_FILE_AT_A_TIME = { ...ISOLATED, fileParallelism: false } as const

// The fixtures and core/plugins are packs: their own tests run on node:test. Live checks run
// only under vitest.live.config.ts (`check --live`), benches under vitest.bench.config.ts.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tools/**/*.test.ts", "checks/**/*.test.ts"],
    exclude: ["**/node_modules/**", "checks/_fixtures/**", "checks/live/**"],
    ...ISOLATED,
  },
})
