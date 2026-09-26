import { join } from "node:path"
import * as FileSystem from "@effect/platform/FileSystem"
import { expect, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { call, login } from "../_layers/api-client.ts"
import { TestServer, testServer, USERS } from "../_layers/test-server.ts"

// Replaces probes/install.mjs, install-store.mjs, install-writes.mjs and install-refusals.mjs
// on a temp store and plugins directory. Only plugin packages: a cube package installs into
// core/src/cubes, the git tree. Removing a required cube is never asked of a live server: if
// that guard regressed, the server would delete core/src/cubes/<cube>. It is proven without a
// server in core/src/cubes/settings/index.test.ts ("protects a required cube").

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

interface Listed {
  readonly name: string
  readonly conflicts: ReadonlyArray<string>
}

/** A store package of kind plugin bringing CUBE; installing copies it, nothing imports it. */
const plantPlugin = (storeDir: string, name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const cubeDir = join(storeDir, name, "cubes", CUBE)
    yield* fs.makeDirectory(cubeDir, { recursive: true })
    yield* fs.writeFileString(join(cubeDir, "index.ts"), "// install-guard fixture\n")
    const manifest = { name, kind: "plugin", summary: "install-guard fixture", cubes: [CUBE] }
    yield* fs.writeFileString(join(storeDir, name, "qwbe-package.json"), JSON.stringify(manifest))
  })

// The store is read per request, so it can be planted after boot.
const withStore = Layer.effectDiscard(
  Effect.flatMap(TestServer, ({ storeDir }) =>
    Effect.all([plantPlugin(storeDir, GUARD), plantPlugin(storeDir, RIVAL)], { discard: true }),
  ),
).pipe(Layer.provideMerge(testServer("install-guard")))

const asAdmin = Effect.flatMap(TestServer, ({ base }) =>
  Effect.map(login(base, "admin", USERS.admin), (token) => ({ base, token })),
)

const installed = Effect.flatMap(TestServer, ({ pluginsDir }) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.orDie(fs.readDirectory(pluginsDir))),
)

const install = (base: string, token: string, name: string) =>
  call(base, `/settings/packages/${encodeURIComponent(name)}/install`, { method: "POST", token })

const uninstall = (base: string, token: string, name: string) =>
  call(base, `/settings/packages/${name}`, { method: "DELETE", token })

const names = (body: unknown) => (body as ReadonlyArray<{ name: string }>).map((entry) => entry.name)

const isClientError = (status: number) => status >= 400 && status < 500

// The tests share one server and run in order: install, clash, undo, traversal.
layer(withStore, { timeout: 60_000, excludeTestServices: true })("the install guard", (it) => {
  it.effect("install copies the plugin, does not mount it and asks for a restart", () =>
    Effect.gen(function* () {
      const { base, token } = yield* asAdmin
      const reply = yield* install(base, token, GUARD)
      expect(reply).toMatchObject({ status: 200, body: { requiresRestart: true } })
      expect(yield* installed).toContain(GUARD)
      expect(names((yield* call(base, "/settings/cubes", { token })).body)).not.toContain(CUBE)
    }),
  )

  it.effect("a second package bringing the same cube is refused and the list shows the clash", () =>
    Effect.gen(function* () {
      const { base, token } = yield* asAdmin
      const rival = yield* install(base, token, RIVAL)
      expect(rival.status).toBe(400)
      expect((rival.body as { message: string }).message).toMatch(new RegExp(`${CUBE}.*${GUARD}`))
      expect(yield* installed).not.toContain(RIVAL)
      const listed = (yield* call(base, "/settings/packages", { token })).body as ReadonlyArray<Listed>
      expect(listed.find((pkg) => pkg.name === RIVAL)?.conflicts).toEqual([CUBE])
    }),
  )

  it.effect("an install is undone before the restart, and a second undo is refused", () =>
    Effect.gen(function* () {
      const { base, token } = yield* asAdmin
      expect((yield* uninstall(base, token, GUARD)).status).toBe(200)
      expect(yield* installed).not.toContain(GUARD)
      expect((yield* uninstall(base, token, GUARD)).status).toBe(400)
    }),
  )

  it.effect("a traversal name is refused and nothing lands in the plugins directory", () =>
    Effect.gen(function* () {
      const { base, token } = yield* asAdmin
      const replies = yield* Effect.forEach(TRAVERSALS, (name) => install(base, token, name))
      expect(TRAVERSALS.filter((_, i) => !isClientError(replies[i]!.status))).toEqual([])
      expect(yield* installed).toEqual([])
    }),
  )
})
