import { createHash } from "node:crypto"
import * as Command from "@effect/platform/Command"
import * as FileSystem from "@effect/platform/FileSystem"
import * as NodeContext from "@effect/platform-node/NodeContext"
import { expect, layer } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { call, login } from "../_layers/api-client.ts"
import { PKG, PKG_CUBE, plantBookmarksCopy } from "../_layers/pack-copy.ts"
import { TestServer, testServer, USERS } from "../_layers/test-server.ts"
import { CORE } from "../_layers/workspace.ts"

// Replaces probes/decoupling.mjs and decoupling-fixtures.mjs: ONE CUBE = ONE DIRECTORY. A plugin
// placed in the plugins directory reaches catalog, OpenAPI, permissions and CLI with no registry
// edited, and no tracked file under core/ changes. The probe's own throwaway cube is not reused:
// it declares no `routes`, so the route-permission rule (manifest-validation.ts) refuses it.
// The plugin here is the renamed bookmarks copy, a cube that passes every mount rule.

type Fingerprints = ReadonlyMap<string, string>

class Before extends Context.Tag("Before")<Before, Fingerprints>() {}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

const hashOf = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFile(`${CORE}/${path}`)).pipe(
    Effect.map(sha256),
    Effect.orElseSucceed(() => "missing"),
  )

const trackedFiles = Command.make("git", "ls-files", "-z").pipe(
  Command.workingDirectory(CORE),
  Command.string,
  Effect.map((out) => out.split("\0").filter(Boolean)),
)

/** SHA-256 of every file git tracks under core/, keyed by its path relative to core/. */
const fingerprints = Effect.gen(function* () {
  const paths = yield* trackedFiles
  const hashes = yield* Effect.forEach(paths, hashOf, { concurrency: 16 })
  return new Map(paths.map((path, i) => [path, hashes[i]!]))
}).pipe(Effect.orDie)

/** Pure: the paths of `before` that are gone or hold other bytes in `after`. */
const changed = (before: Fingerprints, after: Fingerprints) =>
  [...before].filter(([path, hash]) => after.get(path) !== hash).map(([path]) => path)

// Taken first: Layer.provideMerge builds Before before the pack is planted and the server boots.
const setup = testServer("discovery", {}, plantBookmarksCopy).pipe(
  Layer.provideMerge(Layer.effect(Before, fingerprints).pipe(Layer.provide(NodeContext.layer))),
)

const getBody = (base: string, token: string, path: string) =>
  Effect.map(call(base, path, { token }), (reply) => reply.body)

layer(setup, { timeout: 60_000, excludeTestServices: true })("discovery without a registry", (it) => {
  it.effect("the plugin's cube shows up in catalog, routes, OpenAPI, permissions and CLI", () =>
    Effect.gen(function* () {
      const { base } = yield* TestServer
      const token = yield* login(base, "admin", USERS.admin)
      expect(yield* getBody(base, token, "/settings/cubes")).toContainEqual(
        expect.objectContaining({ name: PKG_CUBE, plugin: PKG }),
      )
      expect((yield* call(base, `/${PKG_CUBE}?limit=1`, { token })).status).toBe(200)
      const spec = (yield* getBody(base, token, "/openapi.json")) as { paths: Record<string, unknown> }
      expect(Object.keys(spec.paths)).toContain(`/${PKG_CUBE}`)
      const me = (yield* getBody(base, token, "/auth/me")) as { permissions: ReadonlyArray<string> }
      expect(me.permissions).toContain(`${PKG_CUBE}:read`)
      const commands = (yield* getBody(base, token, "/cli/commands")) as ReadonlyArray<{ name: string }>
      expect(commands.map((command) => command.name)).toContain(`${PKG_CUBE}:count`)
    }),
  )

  it.effect("mounting it changed no tracked file under core/", () =>
    Effect.gen(function* () {
      expect(changed(yield* Before, yield* fingerprints)).toEqual([])
    }),
  )
})
