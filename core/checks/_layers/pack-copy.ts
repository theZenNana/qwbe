import { join } from "node:path"
import * as FileSystem from "@effect/platform/FileSystem"
import * as Effect from "effect/Effect"
import { CORE } from "./workspace.ts"

/** The package planted on the shelf, and the cube inside it. */
export const PKG = "lifecycle-plugin"
export const PKG_CUBE = "lifebookmarks"

const BOOKMARKS = join(CORE, "plugins", "example-plugin", "cubes", "booktags", "bookmarks")

/** Pure: the example bookmarks cube rewritten into a standalone cube named PKG_CUBE. */
export const renameBookmarks = (source: string) =>
  source
    .replaceAll("booktags/bookmarks:", "PPP_COLON")
    .replaceAll("booktags/bookmarks.created", "PPP_EVENT")
    .replaceAll("bookmarks", PKG_CUBE)
    .replaceAll(`"booktags/${PKG_CUBE}"`, `"${PKG_CUBE}"`)
    .replaceAll('"settings-cache"', `"${PKG_CUBE}-cache"`)
    .replaceAll("PPP_COLON", `${PKG_CUBE}:`)
    .replaceAll("PPP_EVENT", `${PKG_CUBE}.created`)
    .replace(/^\s*import \{ decodeBooktagsSettingChanged \} from "\.\.\/events\.ts"\n/m, "")
    .replaceAll("decodeBooktagsSettingChanged(payload)", "payload as { key: string; value: string }")
    .replace(/^\s*parent: "booktags",\n/m, "")

const MANIFEST = { name: PKG, kind: "plugin", summary: "renamed copy of the example bookmarks cube", cubes: [PKG_CUBE] }

/**
 * Plants PKG on the shelf in `storeDir`. Installed, it lands in the workspace plugins directory,
 * as deep under core/ as the example plugin, so its relative imports of core/src still resolve.
 */
export const plantPackage = (storeDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const cubeDir = join(storeDir, PKG, "cubes", PKG_CUBE)
    yield* fs.copy(BOOKMARKS, cubeDir)
    const source = yield* fs.readFileString(join(cubeDir, "index.ts"))
    yield* fs.writeFileString(join(cubeDir, "index.ts"), renameBookmarks(source))
    yield* fs.writeFileString(join(storeDir, PKG, "qwbe-package.json"), JSON.stringify(MANIFEST))
  })
