import { defineConfig } from "vitest/config"

// The benchmarks: slow on purpose, so outside the default run; `check --bench` runs them.
export default defineConfig({
  test: { root: import.meta.dirname, isolate: true, fileParallelism: false, include: ["checks/bench/**/*.test.ts"] },
})
