import { randomBytes } from "node:crypto"
import { expect, layer } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type pg from "pg"
import { run } from "../../src/pg/db.ts"
import { ensureCubeSchema, ensureTable, q, roleName } from "../../src/pg/setup.ts"
import { connect, kernelStore, query } from "../_layers/postgres.ts"
import { TestDb, testDb } from "../_layers/test-db.ts"

// Replaces probes/store-isolation.mjs: nothing in our code checks that one cube cannot read
// another, the Postgres grants do, so only the engine can prove it. A superuser session and the
// application's shape (a non-superuser LOGIN that is a member of every cube role) both switch
// to one cube role and ask for another cube's table.
//
// Roles live in the cluster and survive DROP DATABASE, so every role this file creates carries
// the run's tag, and the finalizer drops every role with that tag, even after a half-done setup.
const TAG = randomBytes(4).toString("hex")
const CUBE_A = `grants-a-${TAG}`
const CUBE_B = `grants-b-${TAG}`
const ROLE_A = roleName(CUBE_A)
const ROLE_B = roleName(CUBE_B)
const APP = `qwbe_grants_app_${TAG}`
const PASSWORD = randomBytes(12).toString("hex")

/** Pure: `url` with its credentials replaced by `user` and `password`. */
const loginUrl = (url: string, user: string, password: string) => {
  const login = new URL(url)
  login.username = user
  login.password = password
  return login.toString()
}

/** Two cubes with one table each, through the store's own setup: the grants under test. */
const createCubes = run(
  Effect.all([
    ensureCubeSchema(CUBE_A),
    ensureCubeSchema(CUBE_B),
    ensureTable(CUBE_A, "secrets"),
    ensureTable(CUBE_B, "notes"),
  ]),
)

const createAppLogin = (admin: pg.Client) =>
  query(admin, `CREATE ROLE ${q(APP)} LOGIN PASSWORD '${PASSWORD}' IN ROLE ${q(ROLE_A)}, ${q(ROLE_B)}`)

/** DROP OWNED clears the grants in this database, which DROP ROLE requires first. */
const dropTaggedRoles = (admin: pg.Client) =>
  Effect.gen(function* () {
    const found = yield* Effect.promise(() =>
      admin.query<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE strpos(rolname, $1) > 0`, [TAG]),
    )
    const roles = found.rows.map((row) => q(row.rolname)).join(", ")
    if (roles === "") return
    yield* query(admin, `DROP OWNED BY ${roles}`)
    yield* query(admin, `DROP ROLE ${roles}`)
  })

/** One session per login shape; both end before the finalizer drops the roles. */
class Sessions extends Context.Tag("Sessions")<
  Sessions,
  { readonly superuser: pg.Client; readonly app: pg.Client }
>() {}

// Finalizers run in reverse: the app session ends, the kernel store closes, then the roles go.
const sessions = Layer.scoped(
  Sessions,
  Effect.gen(function* () {
    const { url } = yield* TestDb
    const superuser = yield* connect(url)
    yield* Effect.addFinalizer(() => dropTaggedRoles(superuser))
    yield* kernelStore(url)
    yield* createCubes
    yield* createAppLogin(superuser)
    const app = yield* connect(loginUrl(url, APP, PASSWORD))
    return { superuser, app }
  }),
).pipe(Layer.provide(testDb("grants")))

/** Runs `sql` as `role` in a transaction that is always rolled back: the refusal, or "" when it ran. */
const refusalOf = (client: pg.Client, role: string, sql: string) =>
  Effect.acquireUseRelease(
    query(client, "BEGIN"),
    () =>
      query(client, `SET LOCAL ROLE ${q(role)}`).pipe(
        Effect.zipRight(Effect.tryPromise({ try: () => client.query(sql), catch: (e) => e as Error })),
        Effect.match({ onSuccess: () => "", onFailure: (e) => e.message }),
      ),
    () => query(client, "ROLLBACK"),
  )

const insertInto = (cube: string, table: string) =>
  `INSERT INTO ${q(cube)}.${q(table)} (id, type, created_at, body) VALUES ('x-1', 'x', now(), '{}')`
const selectFrom = (cube: string, table: string) => `SELECT * FROM ${q(cube)}.${q(table)}`

const DENIED = /permission denied/

layer(sessions, { timeout: 60_000, excludeTestServices: true })("per-cube Postgres grants", (it) => {
  it.effect("each cube role writes its own table and is refused the other cube's, both ways", () =>
    Effect.gen(function* () {
      const { superuser } = yield* Sessions
      expect(yield* refusalOf(superuser, ROLE_A, insertInto(CUBE_A, "secrets"))).toBe("")
      expect(yield* refusalOf(superuser, ROLE_A, selectFrom(CUBE_B, "notes"))).toMatch(DENIED)
      expect(yield* refusalOf(superuser, ROLE_B, insertInto(CUBE_B, "notes"))).toBe("")
      expect(yield* refusalOf(superuser, ROLE_B, selectFrom(CUBE_A, "secrets"))).toMatch(DENIED)
    }),
  )

  it.effect("the application login, as a cube role, writes its own cube and nothing else", () =>
    Effect.gen(function* () {
      const { app } = yield* Sessions
      expect(yield* refusalOf(app, ROLE_A, insertInto(CUBE_A, "secrets"))).toBe("")
      expect(yield* refusalOf(app, ROLE_A, selectFrom(CUBE_B, "notes"))).toMatch(DENIED)
      expect(yield* refusalOf(app, ROLE_A, "SELECT * FROM qwbe.outbox")).toMatch(DENIED)
      expect(yield* refusalOf(app, ROLE_A, "SELECT * FROM qwbe.migrations")).toMatch(DENIED)
    }),
  )
})
