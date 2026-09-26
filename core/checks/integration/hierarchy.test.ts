import { resolve } from "node:path"
import { expect, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { call, login } from "../_layers/api-client.ts"
import { TestServer, testServer } from "../_layers/test-server.ts"

// Ported from probes/booktags.mjs, booktags-fixtures.mjs, booktags-detail-fixtures.mjs and
// smoke-tags.mjs: booktags is the parent of bookmarks, settings and tags in the example-plugin.

const EXAMPLE_PLUGIN = resolve(import.meta.dirname, "../../plugins/example-plugin")
// example-plugin declares data migrations from the flat bookmarks and tags cubes; a fresh ledger has
// no record of them, so the kernel refuses to boot without the operator's authorization.
const LEGACY = "bookmarks:example-plugin,tags:example-plugin"

const post = (base: string, token: string, path: string, body: unknown) =>
  call(base, path, { method: "POST", token, body })

const status = (base: string, token: string, path: string) =>
  call(base, path, { token }).pipe(Effect.map((reply) => reply.status))

const switchCube = (base: string, token: string, cube: string, enabled: boolean) =>
  post(base, token, `/settings/cubes/${encodeURIComponent(cube)}`, { enabled })

const idOf = (body: unknown) => (body as { id: string }).id

const admin = TestServer.pipe(
  Effect.flatMap(({ base }) => login(base, "admin", "admin").pipe(Effect.map((token) => ({ base, token })))),
)

layer(testServer("hierarchy", { packs: [EXAMPLE_PLUGIN], env: { QWBE_LEGACY_MIGRATIONS: LEGACY } }), {
  timeout: 60_000,
  excludeTestServices: true,
})((it) => {
  it.effect("parent off makes every child 404 and hides its commands; standalone cubes stay", () =>
    Effect.gen(function* () {
      const { base, token } = yield* admin
      yield* switchCube(base, token, "booktags", false)
      expect(yield* status(base, token, "/bookmarks?limit=1")).toBe(404)
      expect(yield* status(base, token, "/tags?limit=1")).toBe(404)
      expect(yield* status(base, token, "/notes?limit=1")).toBe(200)
      const command = yield* post(base, token, "/cli/exec", { line: "booktags/bookmarks:count" })
      expect(command.status).toBe(400)
      yield* switchCube(base, token, "booktags", true)
      expect(yield* status(base, token, "/bookmarks?limit=1")).toBe(200)
    }),
  )

  it.effect("one child can be off while its sibling stays on", () =>
    Effect.gen(function* () {
      const { base, token } = yield* admin
      yield* switchCube(base, token, "booktags/tags", false)
      expect(yield* status(base, token, "/tags?limit=1")).toBe(404)
      expect(yield* status(base, token, "/bookmarks?limit=1")).toBe(200)
      yield* switchCube(base, token, "booktags/tags", true)
    }),
  )

  it.effect("a setting changed while bookmarks was off reaches it on re-enable", () =>
    Effect.gen(function* () {
      const { base, token } = yield* admin
      const withUrl = { label: "y", targetCube: "notes", url: "https://x.example.test" }
      yield* post(base, token, "/booktags-settings/enforceTargetCube", { value: "strict" })
      expect((yield* post(base, token, "/bookmarks", withUrl)).status).toBe(400)
      // No settings read between the write and the create: the value must come from the enable event.
      yield* switchCube(base, token, "booktags/bookmarks", false)
      yield* post(base, token, "/booktags-settings/enforceTargetCube", { value: "relaxed" })
      yield* switchCube(base, token, "booktags/bookmarks", true)
      expect((yield* post(base, token, "/bookmarks", withUrl)).status).toBe(200)
    }),
  )

  it.effect("the plugin's second cube answers, and the space relates it to bookmarks", () =>
    Effect.gen(function* () {
      const { base, token } = yield* admin
      const bookmarkId = idOf((yield* post(base, token, "/bookmarks", { label: "b", targetCube: "notes" })).body)
      const tag = yield* post(base, token, "/tags", { label: "docs", bookmarkId })
      expect(tag.status).toBe(200)
      const cubes = (yield* call(base, "/settings/cubes", { token })).body as ReadonlyArray<Record<string, unknown>>
      expect(cubes.find((cube) => cube.name === "booktags/tags")).toMatchObject({
        plugin: "example-plugin",
        parent: "booktags",
      })
      const group = yield* call(base, `/links/Bookmark/${bookmarkId}/booktags%2Ftags?limit=5`, { token })
      expect((group.body as { rows: ReadonlyArray<{ id: string }> }).rows.map((row) => row.id)).toContain(
        idOf(tag.body),
      )
    }),
  )
})
