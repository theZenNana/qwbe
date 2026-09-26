import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import * as FileSystem from "@effect/platform/FileSystem"
import * as NodeContext from "@effect/platform-node/NodeContext"
import { expect, layer } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { call, login } from "../_layers/api-client.ts"
import { TestServer, testServer } from "../_layers/test-server.ts"

// Ported from probes/decoupling.mjs and decoupling-fixtures.mjs: ONE CUBE = ONE DIRECTORY. A plugin
// placed in the plugins directory reaches catalog, OpenAPI, permissions and CLI, and no file under
// core/ changes. Only the plugin path is kept; a new cube in core/src/cubes would write to the tree.

const CORE = resolve(import.meta.dirname, "../..")
const PLUGIN = "zprobeplugin"
const CUBE = "widgets"

const CUBE_SOURCE = `import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization, requirePermission } from "qwbe-core/auth"
import { Forbidden } from "qwbe-core/errors"

const group = HttpApiGroup.make("${CUBE}")
  .add(HttpApiEndpoint.get("hello")\`/${CUBE}/hello\`.addSuccess(Schema.Struct({ message: Schema.String })).addError(Forbidden))
  .middleware(Authorization)

export const cube = {
  manifest: { name: "${CUBE}", tables: [], requiresAuth: true, permissions: [{ name: "${CUBE}:read", roles: ["admin"] }], routes: { hello: null } },
  create: () => ({
    group,
    commands: [{ name: "${CUBE}:ping", summary: "a command that arrives with its cube", permission: "${CUBE}:read", run: () => Effect.succeed("pong") }],
    handlers: { hello: () => requirePermission("${CUBE}:read").pipe(Effect.as({ message: "hello" })) },
  }),
}
`

class Before extends Context.Tag("Before")<Before, ReadonlyMap<string, string>>() {}

// Other check files keep their plugins directories under core/plugins/.check-*; they come and go.
const skipped = (name: string) => name === "node_modules" || name.startsWith(".check-")

/** SHA-256 of every regular file under `dir`, keyed by its path relative to core/; links are not followed. */
const fingerprints = (dir: string, into = new Map<string, string>()): Map<string, string> => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory() && !skipped(entry.name)) fingerprints(path, into)
    else if (entry.isFile())
      into.set(relative(CORE, path), createHash("sha256").update(readFileSync(path)).digest("hex"))
  }
  return into
}

/** Paths from `before` that are gone or hold different bytes in `after`. */
const changed = (before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>) =>
  [...before].filter(([path, hash]) => after.get(path) !== hash).map(([path]) => path)

const writePack = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const pack = join(yield* fs.makeTempDirectoryScoped(), PLUGIN)
  yield* fs.makeDirectory(join(pack, "cubes", CUBE), { recursive: true })
  yield* fs.writeFileString(
    join(pack, "qwbe-package.json"),
    JSON.stringify({ name: PLUGIN, kind: "plugin", cubes: [CUBE] }),
  )
  yield* fs.writeFileString(join(pack, "cubes", CUBE, "index.ts"), CUBE_SOURCE)
  return pack
})

const setup = Layer.unwrapScoped(
  Effect.gen(function* () {
    const before = yield* Effect.sync(() => fingerprints(CORE))
    const pack = yield* writePack
    return Layer.merge(testServer("discovery", { packs: [pack] }), Layer.succeed(Before, before))
  }),
).pipe(Layer.provide(NodeContext.layer))

layer(setup, { timeout: 60_000, excludeTestServices: true })((it) => {
  it.effect("the plugin's cube shows up in catalog, OpenAPI, permissions and CLI", () =>
    Effect.gen(function* () {
      const { base } = yield* TestServer
      const token = yield* login(base, "admin", "admin")
      const get = (path: string) => call(base, path, { token }).pipe(Effect.map((reply) => reply.body as never))
      const cubes: ReadonlyArray<{ name: string; plugin: string | null }> = yield* get("/settings/cubes")
      expect(cubes).toContainEqual(expect.objectContaining({ name: CUBE, plugin: PLUGIN }))
      expect((yield* call(base, `/${CUBE}/hello`, { token })).status).toBe(200)
      const spec: { paths: Record<string, unknown> } = yield* get("/openapi.json")
      expect(Object.keys(spec.paths)).toContain(`/${CUBE}/hello`)
      const me: { permissions: ReadonlyArray<string> } = yield* get("/auth/me")
      expect(me.permissions).toContain(`${CUBE}:read`)
      const commands: ReadonlyArray<{ name: string }> = yield* get("/cli/commands")
      expect(commands.map((command) => command.name)).toContain(`${CUBE}:ping`)
    }),
  )

  it.effect("mounting it changed no existing file under core/", () =>
    Effect.gen(function* () {
      const before = yield* Before
      expect(changed(before, yield* Effect.sync(() => fingerprints(CORE)))).toEqual([])
    }),
  )
})
