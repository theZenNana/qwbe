import { defineConfig, devices } from "@playwright/test"

// Own config, so the project runs on its own rather than borrowing the one in the nest's
// project root.
//
// Serial on purpose: the spec starts the API and the web app itself. In parallel, each test
// would land in its own worker, start another server on the same port, and wipe the databases
// underneath whichever test was running.
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.mjs",
  testIgnore: ["**/node_modules/**"],
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { ...devices["Desktop Chrome"], screenshot: "only-on-failure" },
})
