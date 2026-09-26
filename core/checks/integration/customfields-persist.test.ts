import { resolve } from "node:path"
import { expect, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { call, login } from "../_layers/api-client.ts"
import { TestServer, testServer } from "../_layers/test-server.ts"

// Ported from probes/customfields.mjs, customfields-walk.mjs and customfields-orphan.mjs. Values live
// in the target row's own body under `custom`; the rest of the walk is in custom-values.test.ts and
// customfields/logic.test.ts.
// ponytail: no restart between write and read, testServer boots once per file; add a second boot
// on the same database when the layers can share one.

const GUESTBOOK = resolve(import.meta.dirname, "../../../probes/fixtures/guestbook-pack")
const CUBE = "guestbook"

interface Row {
  readonly id: string
  readonly custom?: Readonly<Record<string, unknown>>
}

const post = (base: string, token: string, path: string, body: unknown) =>
  call(base, path, { method: "POST", token, body })

const readRow = (base: string, token: string, id: string) =>
  call(base, `/${CUBE}/${id}`, { token }).pipe(Effect.map((reply) => reply.body as Row))

layer(testServer("customfields", { packs: [GUESTBOOK] }), { timeout: 60_000, excludeTestServices: true })((it) => {
  it.effect("a value sits in the target row and stays there as an orphan when its definition goes", () =>
    Effect.gen(function* () {
      const { base } = yield* TestServer
      const token = yield* login(base, "admin", "admin")
      const field = { targetCube: CUBE, name: "cnp", fieldType: "text", label: "CNP" }
      const definition = yield* post(base, token, "/customfields", field)
      expect(definition.status).toBe(200)

      const entry = yield* post(base, token, `/${CUBE}`, { name: "Check Entry", cnp: "123456789" })
      expect(entry.status).toBe(200)
      const id = (entry.body as Row).id
      expect(yield* readRow(base, token, id)).toMatchObject({ name: "Check Entry", custom: { cnp: "123456789" } })

      const removed = yield* call(base, `/customfields/${(definition.body as Row).id}`, { method: "DELETE", token })
      expect(removed.body).toEqual({ removed: `${CUBE}.cnp` })
      const orphans = yield* call(base, `/customfields/orphans?cube=${CUBE}`, { token })
      expect((orphans.body as { orphans: ReadonlyArray<unknown> }).orphans).toContainEqual(
        expect.objectContaining({ name: "cnp", rowId: id, value: "123456789" }),
      )
      expect((yield* readRow(base, token, id)).custom).toMatchObject({ cnp: "123456789" })
    }),
  )

  it.effect("a definition for a cube that is not mounted is refused and names the cube", () =>
    Effect.gen(function* () {
      const { base } = yield* TestServer
      const token = yield* login(base, "admin", "admin")
      const refused = yield* post(base, token, "/customfields", {
        targetCube: "nowhere/nothing",
        name: "ghost",
        fieldType: "text",
      })
      expect(refused.status).toBe(400)
      expect((refused.body as { message: string }).message).toContain("nowhere/nothing")
    }),
  )
})
