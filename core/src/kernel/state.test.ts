// The switches had no test at all — so the conversion to Effect brings one, and it exercises
// the file on disk rather than a stubbed writer: what breaks here is a real refusal from a
// real directory, which is the only kind that happens in production.

import { strict as assert } from "node:assert"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeContext } from "@effect/platform-node"
import { Effect, Exit } from "effect"
import { afterAll, test } from "vitest"
import { runNode } from "../files.ts"
import { testConfigLayer } from "../test-config.ts"
import { RequiredCubeError, StateFileError, switchesFrom as switchesIn, UnknownCubeError } from "./state.ts"

const dataDir = mkdtempSync(join(tmpdir(), "qwbe-switches-"))
const stateFile = join(dataDir, "switches.json")

// The data directory reaches the kernel through its config, not through process.env.
const switchesFrom = (mounted: Parameters<typeof switchesIn>[0]) =>
  Effect.provide(switchesIn(mounted), testConfigLayer({ QWBE_DATA_DIR: dataDir }))

const mounted = [
  { name: "auth", required: true },
  { name: "notes", required: false },
]

afterAll(() => chmodSync(dataDir, 0o700))

test("switching a cube off is written to disk and seen at once", async () => {
  const s = await runNode(switchesFrom(mounted))
  assert.equal(s.isEnabled("notes"), true)

  await Effect.runPromise(s.set("notes", false))

  assert.equal(s.isEnabled("notes"), false)
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), { disabled: ["notes"] })
})

test("a required cube is refused as a typed failure, not a thrown error", async () => {
  const s = await runNode(switchesFrom(mounted))
  const exit = await Effect.runPromiseExit(s.set("auth", false))

  assert.equal(Exit.isFailure(exit), true)
  const e = Exit.isFailure(exit) ? (exit.cause as unknown as { error?: unknown }).error : null
  assert.ok(e instanceof RequiredCubeError)
  assert.equal((e as InstanceType<typeof RequiredCubeError>).cube, "auth")
  assert.equal(s.isEnabled("auth"), true)
})

test("a cube that is not mounted is its own failure, distinguishable from the one above", async () => {
  const s = await runNode(switchesFrom(mounted))
  const exit = await Effect.runPromiseExit(s.set("ghost", false))

  assert.equal(Exit.isFailure(exit), true)
  const e = Exit.isFailure(exit) ? (exit.cause as unknown as { error?: unknown }).error : null
  assert.ok(e instanceof UnknownCubeError)
  assert.match((e as InstanceType<typeof UnknownCubeError>).message, /not mounted/)
})

test("a write the disk refuses leaves the running state untouched", async () => {
  writeFileSync(stateFile, `${JSON.stringify({ disabled: [] })}\n`, "utf8")
  const s = await runNode(switchesFrom(mounted))
  chmodSync(stateFile, 0o400) // read-only: the write is refused, the file stays as it was

  const exit = await Effect.runPromiseExit(s.set("notes", false))
  chmodSync(stateFile, 0o600)

  assert.equal(Exit.isFailure(exit), true)
  const e = Exit.isFailure(exit) ? (exit.cause as unknown as { error?: unknown }).error : null
  assert.ok(e instanceof StateFileError)
  // The part that matters: the switch did NOT flip in memory. Otherwise the screen would say
  // "off" while the file says "on", and the next boot would silently undo the user's click.
  assert.equal(s.isEnabled("notes"), true)
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), { disabled: [] })
})

test("a corrupt state file is a typed failure naming the file, never an empty list", async () => {
  // An empty list would switch every disabled cube back on at the next boot.
  writeFileSync(stateFile, "{ not json", "utf8")

  const exit = await Effect.runPromiseExit(Effect.provide(switchesFrom(mounted), NodeContext.layer))

  assert.equal(Exit.isFailure(exit), true)
  const e = Exit.isFailure(exit) ? (exit.cause as unknown as { error?: unknown }).error : null
  assert.ok(e instanceof StateFileError)
  assert.equal((e as InstanceType<typeof StateFileError>).path, stateFile)
  assert.match((e as InstanceType<typeof StateFileError>).message, /switches\.json is corrupt/)
})

test("a disabled cube that no longer exists on disk is dropped from the file", async () => {
  writeFileSync(stateFile, `${JSON.stringify({ disabled: ["notes", "removed-long-ago"] })}\n`, "utf8")

  const s = await runNode(switchesFrom(mounted))

  assert.equal(s.isEnabled("notes"), false)
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), { disabled: ["notes"] })
})
