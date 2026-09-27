import { defineConfig } from "vitest/config"

// No per-file isolation by default: config is a service since the Effect audit (E6), so no
// module reads QWBE_* env at import and one file's env cannot leak into the next file's imports.

/** For the live and bench configs: files that boot real servers must not compete for CPU. */
export const ONE_FILE_AT_A_TIME = { isolate: true, fileParallelism: false } as const

// The fixtures and core/plugins are packs: their own tests run on node:test. Live checks run
// only under vitest.live.config.ts (`check --live`), benches under vitest.bench.config.ts.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tools/**/*.test.ts", "checks/**/*.test.ts"],
    exclude: ["**/node_modules/**", "checks/_fixtures/**", "checks/live/**"],
  },
})
