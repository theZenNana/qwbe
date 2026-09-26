import { randomBytes } from "node:crypto"
import { expect, layer } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import pg from "pg"
import { closeAll, initStore } from "../../src/pg/db.ts"
import { ensureCubeSchema, ensureTable, q, roleName, schemaName } from "../../src/pg/setup.ts"
import { TestDb, testDb } from "../_layers/test-db.ts"

// Roles live in the cluster, not in the database, so every name carries this run's suffix
// and every role is dropped by the finalizer below.
const suffix = randomBytes(4).toString("hex")
const CUBE_A = `grants-a-${suffix}`
const CUBE_B = `grants-b-${suffix}`
const ROLE_A = roleName(schemaName(CUBE_A))
const ROLE_B = roleName(schemaName(CUBE_B))
const APP = `qwbe_grants_app_${suffix}`
const PASSWORD = randomBytes(12).toString("hex")

const connect = (url: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const client = new pg.Client({ connectionString: url })
      await client.connect()
      return client
    }),
    (client) => Effect.promise(() => client.end()),
  )

const asLogin = (url: string, user: string, password: string) => {
  const login = new URL(url)
  login.username = user
  login.password = password
  return login.toString()
}

// The store with two cubes, plus a non-superuser LOGIN that is a member of both cube roles:
// the application's own shape. Superuser would bypass every grant, so it proves nothing alone.
const setUp = (admin: pg.Client, url: string) =>
  Effect.promise(async () => {
    process.env.QWBE_DATABASE_URL = url
    await initStore()
    await ensureCubeSchema(CUBE_A)
    await ensureCubeSchema(CUBE_B)
    await ensureTable(schemaName(CUBE_A), "secrets")
    await ensureTable(schemaName(CUBE_B), "notes")
    await admin.query(`CREATE ROLE ${q(APP)} LOGIN PASSWORD '${PASSWORD}'`)
    await admin.query(`GRANT ${q(ROLE_A)}, ${q(ROLE_B)} TO ${q(APP)}`)
  })

const tearDown = (admin: pg.Client) =>
  Effect.promise(async () => {
    await closeAll()
    const roles = [APP, ROLE_A, ROLE_B].map(q).join(", ")
    await admin.query(`DROP OWNED BY ${roles}`)
    await admin.query(`DROP ROLE IF EXISTS ${roles}`)
  })

/** Runs `sql` under a cube role in a rolled-back transaction; the error message, or "" when it ran. */
const refusal = (client: pg.Client, role: string, sql: string) =>
  Effect.promise(async () => {
    try {
      await client.query("BEGIN")
      await client.query(`SET LOCAL ROLE ${q(role)}`)
      await client.query(sql)
      return ""
    } catch (e) {
      return (e as Error).message
    } finally {
      await client.query("ROLLBACK")
    }
  })

type Login = "superuser" | "app"

/** Asks the engine, as one login switched to one cube role, to run one statement. */
class Engine extends Context.Tag("Engine")<
  Engine,
  (login: Login, role: string, sql: string) => Effect.Effect<string>
>() {}
const engine = Layer.scoped(
  Engine,
  Effect.gen(function* () {
    const { url } = yield* TestDb
    const superuser = yield* connect(url)
    yield* Effect.acquireRelease(setUp(superuser, url), () => tearDown(superuser))
    const app = yield* connect(asLogin(url, APP, PASSWORD))
    const clients = { superuser, app }
    return (login: Login, role: string, sql: string) => refusal(clients[login], role, sql)
  }),
).pipe(Layer.provide(testDb("grants")))

const insertInto = (cube: string, table: string) =>
  `INSERT INTO ${q(schemaName(cube))}.${q(table)} (id, type, created_at, body) VALUES ('x-1', 'x', now(), '{}')`
const selectFrom = (cube: string, table: string) => `SELECT * FROM ${q(schemaName(cube))}.${q(table)}`

layer(engine, { timeout: 60_000, excludeTestServices: true })((it) => {
  it.effect("the engine refuses cube A's role the table of cube B, and the other way round", () =>
    Effect.gen(function* () {
      const run = yield* Engine
      expect(yield* run("superuser", ROLE_A, insertInto(CUBE_A, "secrets"))).toBe("")
      expect(yield* run("superuser", ROLE_A, selectFrom(CUBE_B, "notes"))).toMatch(/permission denied/)
      expect(yield* run("superuser", ROLE_B, insertInto(CUBE_B, "notes"))).toBe("")
      expect(yield* run("superuser", ROLE_B, selectFrom(CUBE_A, "secrets"))).toMatch(/permission denied/)
    }),
  )

  it.effect("the application login cannot read qwbe.outbox and qwbe.migrations", () =>
    Effect.gen(function* () {
      const run = yield* Engine
      expect(yield* run("app", ROLE_A, "SELECT * FROM qwbe.outbox")).toMatch(/permission denied/)
      expect(yield* run("app", ROLE_A, "SELECT * FROM qwbe.migrations")).toMatch(/permission denied/)
      expect(yield* run("app", ROLE_A, selectFrom(CUBE_B, "notes"))).toMatch(/permission denied/)
      expect(yield* run("app", ROLE_A, insertInto(CUBE_A, "secrets"))).toBe("")
    }),
  )
})
