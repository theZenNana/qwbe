import { join } from "node:path"
import { expect, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { call, login } from "../_layers/api-client.ts"
import { copyPack } from "../_layers/pack-copy.ts"
import { TestServer, testServer, USERS } from "../_layers/test-server.ts"
import { CORE } from "../_layers/workspace.ts"

// Replaces probes/booktags.mjs, booktags-fixtures.mjs, booktags-detail-fixtures.mjs and
// smoke-tags.mjs: booktags is the parent of bookmarks, settings and tags in example-plugin.
// The legacy schema move is checks/integration/migration-preflight.test.ts.

const EXAMPLE_PLUGIN = join(CORE, "plugins", "example-plugin")
// example-plugin declares migrations from the flat bookmarks and tags cubes; a fresh ledger has
// no record of them, so the operator's authorization is what lets the kernel boot.
const LEGACY = { QWBE_LEGACY_MIGRATIONS: "bookmarks:example-plugin,tags:example-plugin" }

const post = (base: string, token: string, path: string, body: unknown) =>
  call(base, path, { method: "POST", token, body })

const statusOf = (base: string, token: string, path: string) =>
  Effect.map(call(base, path, { token }), (reply) => reply.status)

const switchCube = (base: string, token: string, cube: string, enabled: boolean) =>
  post(base, token, `/settings/cubes/${encodeURIComponent(cube)}`, { enabled })

const setEnforcement = (base: string, token: string, value: string) =>
  post(base, token, "/booktags-settings/enforceTargetCube", { value })

const idOf = (body: unknown) => (body as { id: string }).id

const rowIds = (body: unknown) => (body as { rows: ReadonlyArray<{ id: string }> }).rows.map((row) => row.id)

const asAdmin = Effect.flatMap(TestServer, ({ base }) =>
  Effect.map(login(base, "admin", USERS.admin), (token) => ({ base, token })),
)

const SERVER = { timeout: 60_000, excludeTestServices: true } as const

layer(testServer("hierarchy", LEGACY, copyPack(EXAMPLE_PLUGIN)), SERVER)("the booktags hierarchy", (it) => {
  it.effect("parent off makes every child 404 and hides its commands; standalone cubes stay", () =>
    Effect.gen(function* () {
      const { base, token } = yield* asAdmin
      yield* switchCube(base, token, "booktags", false)
      expect(yield* statusOf(base, token, "/bookmarks?limit=1")).toBe(404)
      expect(yield* statusOf(base, token, "/tags?limit=1")).toBe(404)
      expect(yield* statusOf(base, token, "/notes?limit=1")).toBe(200)
      expect((yield* post(base, token, "/cli/exec", { line: "booktags/bookmarks:count" })).status).toBe(400)
      yield* switchCube(base, token, "booktags", true)
      expect(yield* statusOf(base, token, "/bookmarks?limit=1")).toBe(200)
    }),
  )

  it.effect("one child can be off while its sibling stays on", () =>
    Effect.gen(function* () {
      const { base, token } = yield* asAdmin
      yield* switchCube(base, token, "booktags/tags", false)
      expect(yield* statusOf(base, token, "/tags?limit=1")).toBe(404)
      expect(yield* statusOf(base, token, "/bookmarks?limit=1")).toBe(200)
      yield* switchCube(base, token, "booktags/tags", true)
    }),
  )

  it.effect("a setting changed while bookmarks was off reaches it on re-enable", () =>
    Effect.gen(function* () {
      const { base, token } = yield* asAdmin
      const withUrl = { label: "y", targetCube: "notes", url: "https://x.example.test" }
      yield* setEnforcement(base, token, "strict")
      expect((yield* post(base, token, "/bookmarks", withUrl)).status).toBe(400)
      // No settings read between the write and the create: the value must come from the bus.
      yield* switchCube(base, token, "booktags/bookmarks", false)
      yield* setEnforcement(base, token, "relaxed")
      yield* switchCube(base, token, "booktags/bookmarks", true)
      expect((yield* post(base, token, "/bookmarks", withUrl)).status).toBe(200)
    }),
  )

  it.effect("a missing bookmark or tag is a semantic 404 that names it", () =>
    Effect.gen(function* () {
      const { base, token } = yield* asAdmin
      expect((yield* call(base, "/bookmarks/bm-missing", { token })).body).toMatchObject({
        message: "bookmark bm-missing does not exist",
      })
      expect((yield* call(base, "/tags/tag-missing", { token })).body).toMatchObject({
        message: "tag tag-missing does not exist",
      })
    }),
  )

  it.effect("the plugin's second cube answers, and the space relates it to bookmarks", () =>
    Effect.gen(function* () {
      const { base, token } = yield* asAdmin
      const bookmarkId = idOf((yield* post(base, token, "/bookmarks", { label: "b", targetCube: "notes" })).body)
      const tag = yield* post(base, token, "/tags", { label: "docs", bookmarkId })
      expect(tag.status).toBe(200)
      const cubes = (yield* call(base, "/settings/cubes", { token })).body as ReadonlyArray<{ name: string }>
      expect(cubes.find((cube) => cube.name === "booktags/tags")).toMatchObject({
        plugin: "example-plugin",
        parent: "booktags",
      })
      const group = yield* call(base, `/links/Bookmark/${bookmarkId}/booktags%2Ftags?limit=5`, { token })
      expect(rowIds(group.body)).toContain(idOf(tag.body))
    }),
  )
})
