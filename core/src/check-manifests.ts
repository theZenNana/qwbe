// The declarations dump -- one input of the generic probes.
//
// Spawned by `qwbe check` (check-package.ts) against the package being judged. Imports each
// cube's entry module the way discovery does and reports what the cube DECLARED about itself:
// `searchable`, `relations`, `dataMigration`.
//
// Why the raw declarations and not the published metadata: the derivation deliberately hides
// broken declarations from clients. A relation whose target is not mounted publishes as
// `relation: null`; a `searchable` name that cannot be an SQL identifier is dropped from the
// list contract. A gate cannot judge what a derivation smoothed away -- the probe must see
// the claim as written, then hold it against the catalog the kernel serves.
//
// Input (environment, set by the caller):
//   QWBE_PACK_DIR         the package directory (qwbe-package.json lives here)
//   QWBE_PACK_CUBES       JSON array of cube names, from the package manifest
//   QWBE_DECLARATIONS_OUT file the JSON result is written to
//
// The result is a file, not stdout: cube modules may print at import time, and one JSON
// document must survive. Exit 0 even when a module fails to import -- the failure is a
// per-cube entry in `errors`, and the caller turns it into a finding with the cube's name.

import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { FileSystem } from "@effect/platform"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Config, Console, Effect, Either, Option, Schema } from "effect"

// A list that does not decode is a caller bug: the probes see an empty package rather than a
// half-read one.
const cubeNames = (raw: string) =>
  Option.getOrElse(Schema.decodeUnknownOption(Schema.parseJson(Schema.Array(Schema.String)))(raw), () => [])

const Declared = Schema.Struct({
  searchable: Schema.optional(Schema.Unknown),
  relations: Schema.optional(Schema.Unknown),
  dataMigration: Schema.optional(Schema.Unknown),
})

const load = (href: string): Promise<Record<string, unknown>> => import(href)

// A cube is whatever the module exports that carries a manifest -- `cube` on packs built with
// the qwbe-core/cube helper, any name on a hand-rolled one. Same rule the package contract's
// hierarchy check uses.
const hasManifest = (v: unknown): v is { readonly manifest: unknown } =>
  v !== null && typeof v === "object" && "manifest" in v

const declarationsOf = (mod: Record<string, unknown>) => {
  const manifest = Object.values(mod).find(hasManifest)?.manifest
  const m: typeof Declared.Type = Option.getOrElse(Schema.decodeUnknownOption(Declared)(manifest), () => ({}))
  return { searchable: m.searchable, relations: m.relations, dataMigration: m.dataMigration }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

const dump = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const outPath = yield* Config.option(Config.string("QWBE_DECLARATIONS_OUT"))
  if (Option.isNone(outPath)) {
    yield* Console.error("check-manifests: QWBE_DECLARATIONS_OUT is not set")
    process.exitCode = 2
    return
  }
  const dir = yield* Config.withDefault(Config.string("QWBE_PACK_DIR"), process.cwd())
  const cubes = cubeNames(yield* Config.withDefault(Config.string("QWBE_PACK_CUBES"), "[]"))

  const out = { cubes: {} as Record<string, ReturnType<typeof declarationsOf>>, errors: {} as Record<string, string> }
  for (const name of cubes) {
    const base = join(dir, "cubes", ...name.split("/"))
    const entry = yield* Effect.findFirst(
      ["index.ts", "index.js"].map((f) => join(base, f)),
      (f) => fs.exists(f),
    )
    if (Option.isNone(entry)) {
      out.errors[name] = `no entry file (index.ts or index.js) under cubes/${name}`
      continue
    }
    const mod = yield* Effect.either(
      Effect.tryPromise({ try: () => load(pathToFileURL(entry.value).href), catch: errorText }),
    )
    if (Either.isLeft(mod)) out.errors[name] = mod.left
    else out.cubes[name] = declarationsOf(mod.right)
  }
  yield* fs.writeFileString(outPath.value, JSON.stringify(out, null, 2))
})

NodeRuntime.runMain(Effect.provide(dump, NodeContext.layer))
