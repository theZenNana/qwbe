// The one place core/src reads QWBE_* env: a service built from effect's Config when its layer
// is built, read with `yield* QwbeConfig`. Nothing reads the environment at import time; the
// server builds the layer once at boot, tests provide their own (test-config.ts).
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Config, Context, Data, Effect, Layer, Option, type Redacted } from "effect"

const srcDir = dirname(fileURLToPath(import.meta.url))

export type QwbeSettings = {
  readonly port: number
  readonly nodeEnv: string
  readonly restartMode: string
  readonly restartCmd: string
  readonly legacyMigrations: string
  /** QWBE_DATA_DIR, or `data/` next to core. */
  readonly dataDir: string
  /** QWBE_PLUGINS_DIR, or `core/plugins`, resolved. */
  readonly pluginsDir: string
  /** QWBE_STORE_DIR as set; each reader keeps its own default. */
  readonly storeDir: string | undefined
  readonly allowedOrigins: string | undefined
  readonly mounted: string | undefined
  readonly adminPassword: Redacted.Redacted | undefined
  readonly readerPassword: Redacted.Redacted | undefined
  readonly cubeVersionsBaseline: string | undefined
  readonly databaseUrl: Redacted.Redacted | undefined
}

export class QwbeConfig extends Context.Tag("qwbe/QwbeConfig")<QwbeConfig, QwbeSettings>() {}

export class ConfigInvalid extends Data.TaggedError("ConfigInvalid")<{ readonly message: string }> {}

const optional = <A>(config: Config.Config<A>) => Config.map(Config.option(config), Option.getOrUndefined)

/** Read the settings from the current ConfigProvider (the environment, unless replaced). */
export const loadConfig: Effect.Effect<QwbeSettings, ConfigInvalid> = Config.all({
  port: Config.port("QWBE_PORT").pipe(Config.withDefault(4500)),
  nodeEnv: Config.string("NODE_ENV").pipe(Config.withDefault("development")),
  restartMode: Config.string("QWBE_RESTART_MODE").pipe(Config.withDefault("inband")),
  restartCmd: Config.string("QWBE_RESTART_CMD").pipe(Config.withDefault("systemctl --user restart qwbe")),
  legacyMigrations: Config.string("QWBE_LEGACY_MIGRATIONS").pipe(Config.withDefault("")),
  dataDir: Config.string("QWBE_DATA_DIR").pipe(Config.withDefault(join(srcDir, "..", "..", "data"))),
  pluginsDir: Config.map(
    Config.string("QWBE_PLUGINS_DIR").pipe(Config.withDefault(join(srcDir, "..", "plugins"))),
    (d) => resolve(d),
  ),
  storeDir: optional(Config.string("QWBE_STORE_DIR")),
  allowedOrigins: optional(Config.string("QWBE_ALLOWED_ORIGINS")),
  mounted: optional(Config.string("QWBE_MOUNTED")),
  adminPassword: optional(Config.redacted("QWBE_ADMIN_PASSWORD")),
  readerPassword: optional(Config.redacted("QWBE_READER_PASSWORD")),
  cubeVersionsBaseline: optional(Config.string("QWBE_CUBE_VERSIONS_BASELINE")),
  databaseUrl: optional(Config.redacted("QWBE_DATABASE_URL")),
}).pipe(Effect.mapError((e) => new ConfigInvalid({ message: String(e) })))

export const QwbeConfigLive = Layer.effect(QwbeConfig, loadConfig)
