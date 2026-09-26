import { join, resolve } from "node:path"
import * as FileSystem from "@effect/platform/FileSystem"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { TestDb, testDb } from "./test-db.ts"

export const CORE = resolve(import.meta.dirname, "../..")

/** What one server boot reads: its database and its data, plugins and store directories. */
export class Workspace extends Context.Tag("Workspace")<
  Workspace,
  { readonly url: string; readonly dataDir: string; readonly pluginsDir: string; readonly storeDir: string }
>() {}

// Packs import the kernel by relative paths and resolve node_modules from where they sit, so the
// plugins directory lives under core/plugins. The dot prefix keeps it out of git (core/plugins/*/
// is ignored) and out of discovery of any server scanning the real core/plugins.
const directories = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const pluginsDir = yield* fs.makeTempDirectoryScoped({ directory: join(CORE, "plugins"), prefix: ".check-" })
  const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "qwbe-check-data-" })
  const storeDir = yield* fs.makeTempDirectoryScoped({ prefix: "qwbe-check-store-" })
  return { dataDir, pluginsDir, storeDir }
})

/** A fresh database and fresh directories; all of it is removed when the scope closes. */
export const workspace = (label: string) =>
  Layer.scoped(
    Workspace,
    Effect.all([TestDb, directories]).pipe(Effect.map(([db, dirs]) => ({ url: db.url, ...dirs }))),
  ).pipe(Layer.provide(testDb(label)))
