import { join } from "node:path"
import { expect, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import { copyPack } from "../_layers/pack-copy.ts"
import { bootedAsAdmin, type Session } from "../_layers/session.ts"
import { testWorkspace } from "../_layers/test-server.ts"
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

const readRow = (admin: Session, id: string) => Effect.map(admin.get(`/${CUBE}/${id}`), (reply) => reply.body as Row)

// The rebuilt runtime may publish the definitions a moment after it answers: bounded retry.
const publishedField = (admin: Session, name: string) =>
  admin.get(`/catalog/${CUBE}/metadata`).pipe(
    Effect.map((reply) => (reply.body as { fields?: ReadonlyArray<Field> }).fields?.find((f) => f.name === name)),
    Effect.filterOrFail((field): field is Field => field !== undefined),
    Effect.retry(Schedule.intersect(Schedule.spaced("300 millis"), Schedule.recurs(10))),
    Effect.orDie,
  )

/** Defines FIELD and writes one entry carrying it; returns both ids. */
const defineAndWrite = (admin: Session) =>
  Effect.gen(function* () {
    const definition = yield* admin.send("POST", "/customfields", FIELD)
    expect(definition.status).toBe(200)
    const entry = yield* admin.send("POST", `/${CUBE}`, { name: "Check Entry", cnp: "123456789" })
    expect(entry.status).toBe(200)
    const id = (entry.body as Row).id
    expect(yield* readRow(admin, id)).toMatchObject({ name: "Check Entry", custom: { cnp: "123456789" } })
    return { id, definitionId: (definition.body as Row).id }
  })

const refuseUnknownTarget = (admin: Session) =>
  Effect.gen(function* () {
    const refused = yield* admin.send("POST", "/customfields", { ...FIELD, targetCube: "nowhere/nothing" })
    expect(refused.status).toBe(400)
    expect((refused.body as { message: string }).message).toContain("nowhere/nothing")
  })

const firstBoot = bootedAsAdmin((admin) => Effect.tap(defineAndWrite(admin), () => refuseUnknownTarget(admin)))

/** The value is still there, the field is published again; removing it leaves the value as an orphan. */
const afterRebuild = (id: string, definitionId: string) =>
  bootedAsAdmin((admin) =>
    Effect.gen(function* () {
      expect((yield* readRow(admin, id)).custom).toMatchObject({ cnp: "123456789" })
      expect((yield* publishedField(admin, "cnp")).custom).toBe(true)
      const removed = yield* admin.send("DELETE", `/customfields/${definitionId}`)
      expect(removed.body).toEqual({ removed: `${CUBE}.cnp` })
      const orphans = yield* admin.get(`/customfields/orphans?cube=${CUBE}`)
      expect((orphans.body as { orphans: ReadonlyArray<unknown> }).orphans).toContainEqual(
        expect.objectContaining({ name: "cnp", rowId: id, value: "123456789" }),
      )
      expect((yield* readRow(admin, id)).custom).toMatchObject({ cnp: "123456789" })
    }),
  )

layer(testWorkspace("customfields"), { timeout: 120_000, excludeTestServices: true })("custom fields", (it) => {
  // One test: the second boot reads what the first wrote, so the two phases cannot be split.
  it.effect(
    "a value survives a runtime rebuild and stays as an orphan when its definition goes",
    () =>
      Effect.gen(function* () {
        yield* copyPack(GUESTBOOK)((yield* Workspace).pluginsDir)
        const { id, definitionId } = yield* firstBoot
        yield* afterRebuild(id, definitionId)
      }),
    // Two full boots take about 4s alone; the 5s default fails under full-suite load.
    30_000,
  )
})
