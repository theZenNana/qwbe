// Test-only: the settings a test runs under, from a map instead of process.env.
import { ConfigProvider, Effect, Layer } from "effect"
import { loadConfig, QwbeConfig, type QwbeSettings } from "./config.ts"

export const testConfig = (env: Readonly<Record<string, string>> = {}): QwbeSettings =>
  Effect.runSync(loadConfig.pipe(Effect.withConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(env))))))

export const testConfigLayer = (env: Readonly<Record<string, string>> = {}) =>
  Layer.succeed(QwbeConfig, testConfig(env))
