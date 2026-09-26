import { defineConfig } from "vitest/config"

// ponytail: files run one at a time; parallel server boots timed out (2026-09-26). Per-file
// isolation already holds, so the upgrade path is finding the shared resource, then turning this on.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    isolate: true,
    fileParallelism: false,
    include: ["tools/**/*.test.ts", "checks/**/*.test.ts"],
  },
})
