import { defineConfig } from "vitest/config"

// `check --bench` (core/tools/bench-budget.ts). Bench mode runs no beforeAll/afterAll, so the one
// server both benches share is booted and stopped by the global setup. One file at a time: the
// staging import must not skew the list timings.
export default defineConfig({
  test: {
    benchmark: { include: ["checks/bench/**/*.bench.ts"] },
    globalSetup: ["checks/bench/server.ts"],
    isolate: true,
    fileParallelism: false,
  },
})
