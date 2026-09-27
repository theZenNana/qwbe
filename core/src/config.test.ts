import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readDataDir, readLegacyMigrations, readMounted, readNodeEnv, readPort, readRestartMode } from "./config.js"

const QWBE_KEYS = [
  "QWBE_PORT",
  "QWBE_RESTART_MODE",
  "QWBE_RESTART_CMD",
  "QWBE_LEGACY_MIGRATIONS",
  "QWBE_DATA_DIR",
  "QWBE_PLUGINS_DIR",
  "QWBE_STORE_DIR",
  "QWBE_ALLOWED_ORIGINS",
  "QWBE_MOUNTED",
  "QWBE_ADMIN_PASSWORD",
  "QWBE_READER_PASSWORD",
  "QWBE_CUBE_VERSIONS_BASELINE",
  "QWBE_DATABASE_URL",
  "NODE_ENV",
] as const

describe("config", () => {
  let saved: NodeJS.ProcessEnv

  beforeEach(() => {
    saved = { ...process.env }
  })

  afterEach(() => {
    process.env = saved
  })

  it("rejects a non-numeric QWBE_PORT", () => {
    process.env.QWBE_PORT = "abc"
    expect(() => readPort()).toThrow(/QWBE_PORT/)
  })

  it("falls back to defaults when nothing is set", () => {
    for (const key of QWBE_KEYS) delete process.env[key]
    expect(readPort()).toBe(4500)
    expect(readNodeEnv()).toBe("development")
    expect(readRestartMode()).toBe("inband")
    expect(readLegacyMigrations()).toBe("")
    expect(readMounted()).toBeUndefined()
    expect(readDataDir("/x")).toBe("/x")
  })

  it("keeps an empty QWBE_MOUNTED (empty is not unset)", () => {
    process.env.QWBE_MOUNTED = ""
    expect(readMounted()).toBe("")
  })
})
