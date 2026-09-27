// The admin connection to the Postgres server the checks, the test databases and `db clean` use.
// Parts, not a URL literal: each QWBE_PG_* variable overrides one piece, and an unset one falls
// back to the local docker-compose stack.

import { Config } from "effect"

const part = (name: string, fallback: string) => Config.withDefault(Config.string(name), fallback)

export const adminUrl = Config.map(
  Config.all([
    part("QWBE_PG_HOST", "localhost"),
    part("QWBE_PG_PORT", "5433"),
    part("QWBE_PG_USER", "postgres"),
    part("QWBE_PG_PASSWORD", "qwbe"),
  ]),
  ([host, port, user, password]) => {
    const url = new URL("postgres://localhost/postgres")
    url.hostname = host
    url.port = port
    url.username = user
    url.password = password
    return url.toString()
  },
)
