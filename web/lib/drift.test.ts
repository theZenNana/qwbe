import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { CubeInfo, PackageInfo } from "./contracts.ts"
import { diskDrift } from "./drift.ts"

const mountedCube = (name: string, onDisk: boolean): CubeInfo => ({
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

const shelfPackage = (name: string, cubes: ReadonlyArray<string>, installed: boolean): PackageInfo => ({
  name,
  kind: "plugin",
  summary: "",
  cubes,
  installed,
  bytes: 0,
  conflicts: [],
})

// The shelf of the old drift probe: the example plugin, installed, and a rival that claims
// `bookmarks` too but was never installed. Mounted, `bookmarks` is `booktags/bookmarks`.
const SHELF = [shelfPackage("example-plugin", ["booktags"], true), shelfPackage("rival-plugin", ["bookmarks"], false)]

describe("diskDrift", () => {
  it("does not read the uninstalled rival's overlap as drift", () => {
    const drift = diskDrift([mountedCube("booktags", true), mountedCube("driftcube", true)], SHELF)
    assert.deepEqual([drift.onDiskNotMounted, drift.mountedNotOnDisk, drift.pendingRestart], [[], [], false])
  })

  it("names exactly the mounted cube that vanished from disk", () => {
    const drift = diskDrift([mountedCube("booktags", true), mountedCube("driftcube", false)], SHELF)
    assert.deepEqual([drift.mountedNotOnDisk, drift.pendingRestart], [["driftcube"], true])
  })

  it("names the installed package whose cube waits for a restart", () => {
    const waiting = shelfPackage("dirplugin", ["dirbookmarks"], true)
    const drift = diskDrift([mountedCube("booktags", true)], [...SHELF, waiting])
    assert.deepEqual([drift.onDiskNotMounted, drift.pendingRestart], [[waiting], true])
  })
})
