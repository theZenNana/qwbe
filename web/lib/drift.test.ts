import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { CubeInfo } from "./api.ts"
import type { PackageInfo } from "./contracts.ts"
import { diskDrift } from "./drift.ts"

const cube = (name: string, onDisk: boolean): CubeInfo => ({
  name,
  parent: null,
  prefix: null,
  enabled: true,
  required: false,
  system: false,
  plugin: null,
  onDisk,
  entity: null,
  screen: false,
  agent: false,
  entityPermissions: false,
  publishes: [],
  links: [],
})

const pack = (name: string, cubes: ReadonlyArray<string>, installed: boolean): PackageInfo => ({
  name,
  kind: "plugin",
  summary: "",
  cubes,
  installed,
  bytes: 0,
  conflicts: [],
})

// The shelf from the old drift probe: the example plugin, installed, and a rival that claims
// `bookmarks` too but was never installed.
const shelf = [pack("example-plugin", ["booktags"], true), pack("rival-plugin", ["bookmarks"], false)]

describe("diskDrift", () => {
  it("does not read an uninstalled rival as drift", () => {
    const drift = diskDrift([cube("booktags", true), cube("driftcube", true)], shelf)
    assert.deepEqual(drift.onDiskNotMounted, [])
    assert.deepEqual(drift.mountedNotOnDisk, [])
    assert.equal(drift.pendingRestart, false)
  })

  it("names exactly the cube that vanished from disk", () => {
    const drift = diskDrift([cube("booktags", true), cube("driftcube", false)], shelf)
    assert.deepEqual(drift.mountedNotOnDisk, ["driftcube"])
    assert.equal(drift.pendingRestart, true)
  })
})
