import { ConfigProvider, Effect, Either, Redacted } from "effect"
import { describe, expect, it } from "vitest"
import { loadConfig } from "./config.ts"
import { testConfig } from "./test-config.ts"

describe("config", () => {
  it("rejects a non-numeric QWBE_PORT as a typed failure", () => {
    const result = Effect.runSync(
      Effect.either(
        loadConfig.pipe(Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["QWBE_PORT", "abc"]])))),
      ),
    )
    expect(Either.isLeft(result) && result.left._tag).toBe("ConfigInvalid")
    expect(Either.isLeft(result) && result.left.message).toMatch(/QWBE_PORT/)
  })

  it("falls back to defaults when nothing is set", () => {
    const config = testConfig()
    expect(config.port).toBe(4500)
    expect(config.nodeEnv).toBe("development")
    expect(config.restartMode).toBe("inband")
    expect(config.legacyMigrations).toBe("")
    expect(config.mounted).toBeUndefined()
    expect(config.storeDir).toBeUndefined()
    expect(config.dataDir).toMatch(/data$/)
  })

  it("keeps an empty QWBE_MOUNTED (empty is not unset)", () => {
    expect(testConfig({ QWBE_MOUNTED: "" }).mounted).toBe("")
  })

  it("keeps secrets redacted", () => {
    const { databaseUrl } = testConfig({ QWBE_DATABASE_URL: "postgres://u:secret@h/d" })
    expect(String(databaseUrl)).not.toContain("secret")
    expect(databaseUrl && Redacted.value(databaseUrl)).toBe("postgres://u:secret@h/d")
  })
})
