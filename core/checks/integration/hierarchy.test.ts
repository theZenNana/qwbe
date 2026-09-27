import { join } from "node:path"
import { expect, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { copyPack } from "../_layers/pack-copy.ts"
import { asAdmin } from "../_layers/session.ts"
import { testServer } from "../_layers/test-server.ts"
import { CORE } from "../_layers/workspace.ts"

// Replaces probes/booktags.mjs, booktags-fixtures.mjs, booktags-detail-fixtures.mjs and
// smoke-tags.mjs: booktags is the parent of bookmarks, settings and tags in example-plugin.
// The legacy schema move is checks/integration/migration-preflight.test.ts.

const EXAMPLE_PLUGIN = join(CORE, "plugins", "example-plugin")
// example-plugin declares migrations from the flat bookmarks and tags cubes; a fresh ledger has
// no record of them, so the operator's authorization is what lets the kernel boot.
const LEGACY = { QWBE_LEGACY_MIGRATIONS: "bookmarks:example-plugin,tags:example-plugin" }
const ENFORCEMENT = "/booktags-settings/enforceTargetCube"

const idOf = (body: unknown) => (body as { id: string }).id

const rowIds = (body: unknown) => (body as { rows: ReadonlyArray<{ id: string }> }).rows.map((row) => row.id)

const SERVER = { timeout: 60_000, excludeTestServices: true } as const

layer(testServer("hierarchy", LEGACY, copyPack(EXAMPLE_PLUGIN)), SERVER)("the booktags hierarchy", (it) => {
  it.effect("parent off makes every child 404 and hides its commands; standalone cubes stay", () =>
    Effect.gen(function* () {
      const admin = yield* asAdmin
      yield* admin.switchCube("booktags", false)
      expect(yield* admin.status("/bookmarks?limit=1")).toBe(404)
      expect(yield* admin.status("/tags?limit=1")).toBe(404)
      expect(yield* admin.status("/notes?limit=1")).toBe(200)
      expect((yield* admin.send("POST", "/cli/exec", { line: "booktags/bookmarks:count" })).status).toBe(400)
      yield* admin.switchCube("booktags", true)
      expect(yield* admin.status("/bookmarks?limit=1")).toBe(200)
    }),
  )

  it.effect("one child can be off while its sibling stays on", () =>
    Effect.gen(function* () {
      const admin = yield* asAdmin
      yield* admin.switchCube("booktags/tags", false)
      expect(yield* admin.status("/tags?limit=1")).toBe(404)
      expect(yield* admin.status("/bookmarks?limit=1")).toBe(200)
      yield* admin.switchCube("booktags/tags", true)
    }),
  )

  it.effect("a setting changed while bookmarks was off reaches it on re-enable", () =>
    Effect.gen(function* () {
      const admin = yield* asAdmin
      const withUrl = { label: "y", targetCube: "notes", url: "https://x.example.test" }
      yield* admin.send("POST", ENFORCEMENT, { value: "strict" })
      expect((yield* admin.send("POST", "/bookmarks", withUrl)).status).toBe(400)
      // No settings read between the write and the create: the value must come from the bus.
      yield* admin.switchCube("booktags/bookmarks", false)
      yield* admin.send("POST", ENFORCEMENT, { value: "relaxed" })
      yield* admin.switchCube("booktags/bookmarks", true)
      expect((yield* admin.send("POST", "/bookmarks", withUrl)).status).toBe(200)
    }),
  )

  it.effect("a missing bookmark or tag is a semantic 404 that names it", () =>
    Effect.gen(function* () {
      const admin = yield* asAdmin
      expect((yield* admin.get("/bookmarks/bm-missing")).body).toMatchObject({
        message: "bookmark bm-missing does not exist",
      })
      expect((yield* admin.get("/tags/tag-missing")).body).toMatchObject({
        message: "tag tag-missing does not exist",
      })
    }),
  )

  it.effect("the plugin's second cube answers, and the space relates it to bookmarks", () =>
    Effect.gen(function* () {
      const admin = yield* asAdmin
      const bookmarkId = idOf((yield* admin.send("POST", "/bookmarks", { label: "b", targetCube: "notes" })).body)
      const tag = yield* admin.send("POST", "/tags", { label: "docs", bookmarkId })
      expect(tag.status).toBe(200)
      const cubes = (yield* admin.get("/settings/cubes")).body as ReadonlyArray<{ name: string }>
      expect(cubes.find((cube) => cube.name === "booktags/tags")).toMatchObject({
        plugin: "example-plugin",
        parent: "booktags",
      })
      const group = yield* admin.get(`/links/Bookmark/${bookmarkId}/booktags%2Ftags?limit=5`)
      expect(rowIds(group.body)).toContain(idOf(tag.body))
    }),
  )
})
