// The switches had no test at all — so the conversion to Effect brings one, and it exercises
// the file on disk rather than a stubbed writer: what breaks here is a real refusal from a
// real directory, which is the only kind that happens in production.

import { strict as assert } from "node:assert"
import { chmodSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { FileSystem } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { testConfigLayer } from "../test-config.ts"
import { RequiredCubeError, StateFileError, switchesFrom as switchesIn, UnknownCubeError } from "./state.ts"

/** A fresh data directory per test, removed when the test's scope closes, even on failure. */
const dataDir = Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectoryScoped({ prefix: "qwbe-switches-" }))
const stateFileIn = (dir: string) => join(dir, "switches.json")

// The data directory reaches the kernel through its config, not through process.env.
const switchesFrom = (dir: string, mounted: Parameters<typeof switchesIn>[0]) =>
  Effect.provide(switchesIn(mounted), testConfigLayer({ QWBE_DATA_DIR: dir }))

const mounted = [
  { name: "auth", required: true },
  { name: "notes", required: false },
]

layer(NodeContext.layer)("switches", (it) => {
  it.scoped("switching a cube off is written to disk and seen at once", () =>
    Effect.gen(function* () {
      const dir = yield* dataDir
      const s = yield* switchesFrom(dir, mounted)
      assert.equal(s.isEnabled("notes"), true)

      yield* s.set("notes", false)

      assert.equal(s.isEnabled("notes"), false)
      assert.deepEqual(JSON.parse(readFileSync(stateFileIn(dir), "utf8")), { disabled: ["notes"] })
    }),
  )

  it.scoped("a required cube is refused as a typed failure, not a thrown error", () =>
    Effect.gen(function* () {
      const s = yield* switchesFrom(yield* dataDir, mounted)
      const e = yield* Effect.flip(s.set("auth", false))

      assert.ok(e instanceof RequiredCubeError)
      assert.equal(e.cube, "auth")
      assert.equal(s.isEnabled("auth"), true)
    }),
  )

  it.scoped("a cube that is not mounted is its own failure, distinguishable from the one above", () =>
    Effect.gen(function* () {
      const s = yield* switchesFrom(yield* dataDir, mounted)
      const e = yield* Effect.flip(s.set("ghost", false))

      assert.ok(e instanceof UnknownCubeError)
      assert.match(e.message, /not mounted/)
    }),
  )

  it.scoped("a write the disk refuses leaves the running state untouched", () =>
    Effect.gen(function* () {
      const dir = yield* dataDir
      const stateFile = stateFileIn(dir)
      writeFileSync(stateFile, `${JSON.stringify({ disabled: [] })}\n`, "utf8")
      const s = yield* switchesFrom(dir, mounted)
      chmodSync(stateFile, 0o400) // read-only: the write is refused, the file stays as it was

      const e = yield* Effect.flip(s.set("notes", false)).pipe(
        Effect.ensuring(Effect.sync(() => chmodSync(stateFile, 0o600))),
      )

      assert.ok(e instanceof StateFileError)
      // The part that matters: the switch did NOT flip in memory. Otherwise the screen would say
      // "off" while the file says "on", and the next boot would silently undo the user's click.
      assert.equal(s.isEnabled("notes"), true)
      assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), { disabled: [] })
    }),
  )

  it.scoped("a corrupt state file is a typed failure naming the file, never an empty list", () =>
    Effect.gen(function* () {
      const dir = yield* dataDir
      // An empty list would switch every disabled cube back on at the next boot.
      writeFileSync(stateFileIn(dir), "{ not json", "utf8")

      const e = yield* Effect.flip(switchesFrom(dir, mounted))

      assert.ok(e instanceof StateFileError)
      assert.equal(e.path, stateFileIn(dir))
      assert.match(e.message, /switches\.json is corrupt/)
    }),
  )

  it.scoped("a disabled cube that no longer exists on disk is dropped from the file", () =>
    Effect.gen(function* () {
      const dir = yield* dataDir
      writeFileSync(stateFileIn(dir), `${JSON.stringify({ disabled: ["notes", "removed-long-ago"] })}\n`, "utf8")

      const s = yield* switchesFrom(dir, mounted)

      assert.equal(s.isEnabled("notes"), false)
      assert.deepEqual(JSON.parse(readFileSync(stateFileIn(dir), "utf8")), { disabled: ["notes"] })
    }),
  )
})
