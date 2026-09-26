import { defineConfig } from "vitest/config"

export default defineConfig({
  test: { root: import.meta.dirname, isolate: true, include: ["tools/**/*.test.ts"] },
})
