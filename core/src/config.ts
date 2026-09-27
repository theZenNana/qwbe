// The one place core/src reads QWBE_* env, validated by effect's Config. Every reader re-reads
// the environment on each call, so each caller keeps the moment it reads at.
import { Config, Effect, Option } from "effect"

const read = <A>(config: Config.Config<A>): A => Effect.runSync(config)
const optional = (name: string): string | undefined => Option.getOrUndefined(read(Config.option(Config.string(name))))

export const readPort = (): number => read(Config.port("QWBE_PORT").pipe(Config.withDefault(4500)))
export const readNodeEnv = (): string => read(Config.string("NODE_ENV").pipe(Config.withDefault("development")))
export const readRestartMode = (): string => read(Config.string("QWBE_RESTART_MODE").pipe(Config.withDefault("inband")))
export const readRestartCmd = (): string =>
  read(Config.string("QWBE_RESTART_CMD").pipe(Config.withDefault("systemctl --user restart qwbe")))
export const readLegacyMigrations = (): string =>
  read(Config.string("QWBE_LEGACY_MIGRATIONS").pipe(Config.withDefault("")))
export const readDataDir = (fallback: string): string => optional("QWBE_DATA_DIR") ?? fallback
export const readPluginsDir = (fallback: string): string => optional("QWBE_PLUGINS_DIR") ?? fallback
export const readStoreDir = (): string | undefined => optional("QWBE_STORE_DIR")
export const readAllowedOrigins = (): string | undefined => optional("QWBE_ALLOWED_ORIGINS")
export const readMounted = (): string | undefined => optional("QWBE_MOUNTED")
export const readAdminPassword = (): string | undefined => optional("QWBE_ADMIN_PASSWORD")
export const readReaderPassword = (): string | undefined => optional("QWBE_READER_PASSWORD")
export const readCubeVersionsBaseline = (): string | undefined => optional("QWBE_CUBE_VERSIONS_BASELINE")
export const readDatabaseUrl = (): string | undefined => optional("QWBE_DATABASE_URL")
