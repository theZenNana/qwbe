import { join } from "node:path"
import { expect, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import { call, login } from "../_layers/api-client.ts"
import { boot } from "../_layers/boot.ts"
import { copyPack } from "../_layers/pack-copy.ts"
import { testWorkspace, USERS } from "../_layers/test-server.ts"
import { CORE, Workspace } from "../_layers/workspace.ts"

// Replaces probes/customfields.mjs, customfields-walk.mjs and customfields-orphan.mjs. Values live
// in the target row's own body under `custom`. The restart is a second boot on the same
// database; the rest of the walk is in custom-values.test.ts and customfields/logic.test.ts.

const GUESTBOOK = join(CORE, "checks", "_fixtures", "guestbook-pack")
const CUBE = "guestbook"
const FIELD = { targetCube: CUBE, name: "cnp", fieldType: "text", label: "CNP" }

interface Row {
  readonly id: string
  readonly custom?: Readonly<Record<string, unknown>>
}

interface Field {
  readonly name: string
  readonly custom?: boolean
}

/** One server over the workspace for the length of `use`, with an admin session on it. */
const withAdmin = <A, E, R>(use: (base: string, token: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = yield* boot()
      return yield* use(base, yield* login(base, "admin", USERS.admin))
    }),
  )

const post = (base: string, token: string, path: string, body: unknown) =>
  call(base, path, { method: "POST", token, body })

const readRow = (base: string, token: string, id: string) =>
  Effect.map(call(base, `/${CUBE}/${id}`, { token }), (reply) => reply.body as Row)

// The rebuilt runtime may publish the definitions a moment after it answers: bounded retry.
const publishedField = (base: string, token: string, name: string) =>
  call(base, `/catalog/${CUBE}/metadata`, { token }).pipe(
    Effect.map((reply) => (reply.body as { fields?: ReadonlyArray<Field> }).fields?.find((f) => f.name === name)),
    Effect.filterOrFail((field): field is Field => field !== undefined),
    Effect.retry(Schedule.intersect(Schedule.spaced("300 millis"), Schedule.recurs(10))),
    Effect.orDie,
  )

const firstBoot = withAdmin((base, token) =>
  Effect.gen(function* () {
    const definition = yield* post(base, token, "/customfields", FIELD)
    expect(definition.status).toBe(200)
    const entry = yield* post(base, token, `/${CUBE}`, { name: "Check Entry", cnp: "123456789" })
    expect(entry.status).toBe(200)
    const id = (entry.body as Row).id
    expect(yield* readRow(base, token, id)).toMatchObject({ name: "Check Entry", custom: { cnp: "123456789" } })
    const refused = yield* post(base, token, "/customfields", { ...FIELD, targetCube: "nowhere/nothing" })
    expect(refused.status).toBe(400)
    expect((refused.body as { message: string }).message).toContain("nowhere/nothing")
    return { id, definitionId: (definition.body as Row).id }
  }),
)

const afterRebuild = (id: string, definitionId: string) =>
  withAdmin((base, token) =>
    Effect.gen(function* () {
      expect((yield* readRow(base, token, id)).custom).toMatchObject({ cnp: "123456789" })
      expect((yield* publishedField(base, token, "cnp")).custom).toBe(true)
      const removed = yield* call(base, `/customfields/${definitionId}`, { method: "DELETE", token })
      expect(removed.body).toEqual({ removed: `${CUBE}.cnp` })
      const orphans = yield* call(base, `/customfields/orphans?cube=${CUBE}`, { token })
      expect((orphans.body as { orphans: ReadonlyArray<unknown> }).orphans).toContainEqual(
        expect.objectContaining({ name: "cnp", rowId: id, value: "123456789" }),
      )
      expect((yield* readRow(base, token, id)).custom).toMatchObject({ cnp: "123456789" })
    }),
  )

layer(testWorkspace("customfields"), { timeout: 120_000, excludeTestServices: true })("custom fields", (it) => {
  // One test: the second boot reads what the first wrote, so the two phases cannot be split.
  it.effect("a value survives a runtime rebuild and stays as an orphan when its definition goes", () =>
    Effect.gen(function* () {
      yield* copyPack(GUESTBOOK)((yield* Workspace).pluginsDir)
      const { id, definitionId } = yield* firstBoot
      yield* afterRebuild(id, definitionId)
    }),
  )
})
