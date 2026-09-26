import { join } from "node:path"
import * as FileSystem from "@effect/platform/FileSystem"
import { expect, layer } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { call, login, type Reply } from "../_layers/api-client.ts"
import { TestServer, testServer } from "../_layers/test-server.ts"

// Only plugin packages: a cube package installs into core/src/cubes, which is the git tree.
const GUARD = "guardplugin"
const RIVAL = "rivalplugin"
const CUBE = "guardcube"
const TRAVERSALS = [
  "..",
  "../../../etc",
  "..%2f..%2fetc",
  "a/b",
  "a\\b",
  ".",
  "Guardplugin",
  "guard.plugin",
  "guard ",
  "",
]

/** A store package of kind plugin that brings one cube. */
const plantPlugin = (fs: FileSystem.FileSystem, storeDir: string, name: string) =>
  Effect.gen(function* () {
    yield* fs.makeDirectory(join(storeDir, name, "cubes", CUBE), { recursive: true })
    yield* fs.writeFileString(join(storeDir, name, "cubes", CUBE, "index.ts"), "// install-guard fixture\n")
    yield* fs.writeFileString(
      join(storeDir, name, "qwbe-package.json"),
      JSON.stringify({ name, kind: "plugin", summary: "install-guard fixture", cubes: [CUBE] }),
    )
  })

/** The admin's view of one booted server: HTTP with a token taken once, and its plugins directory. */
class Admin extends Context.Tag("Admin")<
  Admin,
  {
    readonly call: (method: string, path: string) => Effect.Effect<Reply>
    readonly plugins: () => Effect.Effect<ReadonlyArray<string>>
  }
>() {}

// Two packages bringing the same cube, planted in the server's temp store after boot.
const admin = Layer.effect(
  Admin,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { base, storeDir, pluginsDir } = yield* TestServer
    yield* Effect.all([plantPlugin(fs, storeDir, GUARD), plantPlugin(fs, storeDir, RIVAL)])
    const token = yield* login(base, "admin", "admin")
    return {
      call: (method: string, path: string) => call(base, path, { method, token }),
      plugins: () => fs.readDirectory(pluginsDir).pipe(Effect.orDie),
    }
  }),
).pipe(Layer.provide(testServer("install-guard")))

const names = (body: unknown) => (body as ReadonlyArray<{ name: string }>).map((entry) => entry.name)

// The tests run in order and share one server: install, clash, undo.
layer(admin, { timeout: 60_000, excludeTestServices: true })((it) => {
  it.effect("install copies the plugin, does not mount it and asks for a restart", () =>
    Effect.gen(function* () {
      const admin = yield* Admin
      const installed = yield* admin.call("POST", `/settings/packages/${GUARD}/install`)
      expect(installed.status).toBe(200)
      expect((installed.body as { requiresRestart?: boolean }).requiresRestart).toBe(true)
      expect((yield* admin.plugins()).includes(GUARD)).toBe(true)
      expect(names((yield* admin.call("GET", "/settings/cubes")).body)).not.toContain(CUBE)
    }),
  )

  it.effect("a second package bringing the same cube is refused and the list shows the clash", () =>
    Effect.gen(function* () {
      const admin = yield* Admin
      const rival = yield* admin.call("POST", `/settings/packages/${RIVAL}/install`)
      expect(rival.status).toBe(400)
      expect((rival.body as { message: string }).message).toMatch(new RegExp(`${CUBE}.*${GUARD}`))
      expect((yield* admin.plugins()).includes(RIVAL)).toBe(false)
      const listed = (yield* admin.call("GET", "/settings/packages")).body as ReadonlyArray<{
        name: string
        conflicts: ReadonlyArray<string>
      }>
      expect(listed.find((p) => p.name === RIVAL)?.conflicts).toEqual([CUBE])
    }),
  )

  it.effect("an install is undone before the restart, and a second undo is refused", () =>
    Effect.gen(function* () {
      const admin = yield* Admin
      expect((yield* admin.call("DELETE", `/settings/packages/${GUARD}`)).status).toBe(200)
      expect((yield* admin.plugins()).includes(GUARD)).toBe(false)
      expect((yield* admin.call("DELETE", `/settings/packages/${GUARD}`)).status).toBe(400)
    }),
  )

  it.effect("a traversal name is refused and nothing lands in the plugins directory", () =>
    Effect.gen(function* () {
      const admin = yield* Admin
      for (const name of TRAVERSALS) {
        const reply = yield* admin.call("POST", `/settings/packages/${encodeURIComponent(name)}/install`)
        expect({ name, refused: reply.status >= 400 && reply.status < 500 }).toEqual({ name, refused: true })
      }
      expect(yield* admin.plugins()).toEqual([])
    }),
  )
  // "A required cube cannot be removed" is not asked of a live server here: if that guard ever
  // regressed, the server would delete core/src/cubes/<cube> from the git tree. The guard is
  // covered without a server by core/src/cubes/settings/index.test.ts.
})
